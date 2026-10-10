import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withStackEnv } from './stack_environment.mjs';
import { resolveStackServerEndpoint } from '../utils/server/urls.mjs';
import { applyStackCacheEnv } from '../utils/proc/pm.mjs';
import { resolveCommandPath } from '../utils/proc/commands.mjs';
import { spawnProc } from '../utils/proc/proc.mjs';

async function withTempStackEnvFixture(fn, { includeServerPort = true } = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-env-sanitize-'));
  const storageDir = join(tmp, 'storage');
  const stackName = 'sanitize';
  const stackDir = join(storageDir, stackName);

  await mkdir(stackDir, { recursive: true });
  await writeFile(
    join(stackDir, 'env'),
    [
      'HAPPIER_STACK_REPO_DIR=/tmp/happier',
      `HAPPIER_STACK_CLI_HOME_DIR=${join(storageDir, stackName, 'cli')}`,
      ...(includeServerPort ? ['HAPPIER_STACK_SERVER_PORT=3555'] : []),
      '',
    ].join('\n'),
    'utf-8',
  );

  const previousStorageDir = process.env.HAPPIER_STACK_STORAGE_DIR;
  process.env.HAPPIER_STACK_STORAGE_DIR = storageDir;

  try {
    await fn({ stackName, storageDir });
  } finally {
    if (typeof previousStorageDir === 'undefined') {
      delete process.env.HAPPIER_STACK_STORAGE_DIR;
    } else {
      process.env.HAPPIER_STACK_STORAGE_DIR = previousStorageDir;
    }
    await rm(tmp, { recursive: true, force: true });
  }
}

test('withStackEnv persists runtime stdout and stderr in the selected stack logs', async () => {
  await withTempStackEnvFixture(async ({ stackName, storageDir }) => {
    const previous = process.env.HAPPIER_STACK_LOG_TEE_DIR;
    process.env.HAPPIER_STACK_LOG_TEE_DIR = join(storageDir, 'foreign-stack', 'logs');
    try {
      await withStackEnv({
        stackName,
        reconcileDaemonRuntimeState: false,
        fn: async ({ env }) => {
          // Stack's run entry loads this environment again in its child process.
          const script = `
            await import(${JSON.stringify(new URL('../utils/env/env.mjs', import.meta.url).href)});
            const { spawnProc } = await import(${JSON.stringify(new URL('../utils/proc/proc.mjs', import.meta.url).href)});
            for (const label of ['server', 'daemon']) {
              const child = spawnProc(label, process.execPath,
                ['-e', 'console.log("runtime stdout"); console.error("runtime stderr")'], process.env, { silent: true });
              if ((await child.completion).code !== 0) process.exitCode = 1;
            }
          `;
          const entry = spawnProc('stack-start', process.execPath, ['--input-type=module', '-e', script], env,
            { silent: true, persistOutput: false });
          assert.equal((await entry.completion).code, 0);
          for (const label of ['server', 'daemon']) {
            const log = await readFile(join(storageDir, stackName, 'logs', `${label}.log`), 'utf8');
            assert.match(log, /runtime stdout/);
            assert.match(log, /runtime stderr/);
          }
        },
      });
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_STACK_LOG_TEE_DIR;
      else process.env.HAPPIER_STACK_LOG_TEE_DIR = previous;
    }
  });
});

test('withStackEnv clears leaked unprefixed server/home env vars from caller scope', async () => {
  await withTempStackEnvFixture(async ({ stackName }) => {
    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
    const previousPublicServerUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;
    const previousLocalServerUrl = process.env.HAPPIER_LOCAL_SERVER_URL;
    const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const previousHomeDir = process.env.HAPPIER_HOME_DIR;
    const previousActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;
    const previousConnectedServiceTargetMaterializedRoot = process.env.HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT;
    const previousAppEnv = process.env.APP_ENV;
    const previousExpoUpdatesChannel = process.env.EXPO_UPDATES_CHANNEL;
    const previousExpoPublicFeaturePolicy = process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV;
    const previousExpoPublicBuildFeaturesAllow = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
    const previousExpoPublicBuildFeaturesDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
    const previousFeaturePolicyEnv = process.env.HAPPIER_FEATURE_POLICY_ENV;
    const previousEmbeddedPolicyEnv = process.env.HAPPIER_EMBEDDED_POLICY_ENV;
    const previousBuildFeaturesAllow = process.env.HAPPIER_BUILD_FEATURES_ALLOW;
    const previousBuildFeaturesDeny = process.env.HAPPIER_BUILD_FEATURES_DENY;

    process.env.HAPPIER_SERVER_URL = 'http://stale.localhost:9999';
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'http://stale.localhost:9999';
    process.env.HAPPIER_LOCAL_SERVER_URL = 'http://stale.localhost:9999';
    process.env.HAPPIER_WEBAPP_URL = 'http://stale.localhost:9999';
    process.env.HAPPIER_HOME_DIR = '/tmp/stale-home';
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'stack_stale__id_default';
    process.env.HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT = '/tmp/stale-connected-service-root';
    process.env.APP_ENV = 'preview';
    process.env.EXPO_UPDATES_CHANNEL = 'preview';
    process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV = 'preview';
    process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = 'voice';
    process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'automations';
    process.env.HAPPIER_FEATURE_POLICY_ENV = 'preview';
    process.env.HAPPIER_EMBEDDED_POLICY_ENV = 'preview';
    process.env.HAPPIER_BUILD_FEATURES_DENY = 'automations';
    process.env.HAPPIER_BUILD_FEATURES_ALLOW = 'voice';

    try {
      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          assert.equal(env.HAPPIER_SERVER_URL, undefined);
          assert.equal(env.HAPPIER_PUBLIC_SERVER_URL, undefined);
          assert.equal(env.HAPPIER_LOCAL_SERVER_URL, undefined);
          assert.equal(env.HAPPIER_WEBAPP_URL, undefined);
          assert.equal(env.HAPPIER_HOME_DIR, undefined);
          assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, 'stack_sanitize__id_default');
          assert.equal(env.HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT, undefined);
          assert.equal(env.APP_ENV, undefined);
          assert.equal(env.EXPO_UPDATES_CHANNEL, undefined);
          assert.equal(env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV, undefined);
          assert.equal(env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY, undefined);
          assert.equal(env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW, undefined);
          assert.equal(env.HAPPIER_FEATURE_POLICY_ENV, undefined);
          assert.equal(env.HAPPIER_EMBEDDED_POLICY_ENV, undefined);
          assert.equal(env.HAPPIER_BUILD_FEATURES_DENY, undefined);
          assert.equal(env.HAPPIER_BUILD_FEATURES_ALLOW, undefined);
        },
      });
    } finally {
      if (typeof previousServerUrl === 'undefined') delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = previousServerUrl;
      if (typeof previousPublicServerUrl === 'undefined') delete process.env.HAPPIER_PUBLIC_SERVER_URL;
      else process.env.HAPPIER_PUBLIC_SERVER_URL = previousPublicServerUrl;
      if (typeof previousLocalServerUrl === 'undefined') delete process.env.HAPPIER_LOCAL_SERVER_URL;
      else process.env.HAPPIER_LOCAL_SERVER_URL = previousLocalServerUrl;
      if (typeof previousWebappUrl === 'undefined') delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = previousWebappUrl;
      if (typeof previousHomeDir === 'undefined') delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = previousHomeDir;
      if (typeof previousActiveServerId === 'undefined') delete process.env.HAPPIER_ACTIVE_SERVER_ID;
      else process.env.HAPPIER_ACTIVE_SERVER_ID = previousActiveServerId;
      if (typeof previousConnectedServiceTargetMaterializedRoot === 'undefined') delete process.env.HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT;
      else process.env.HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT = previousConnectedServiceTargetMaterializedRoot;
      if (typeof previousAppEnv === 'undefined') delete process.env.APP_ENV;
      else process.env.APP_ENV = previousAppEnv;
      if (typeof previousExpoUpdatesChannel === 'undefined') delete process.env.EXPO_UPDATES_CHANNEL;
      else process.env.EXPO_UPDATES_CHANNEL = previousExpoUpdatesChannel;
      if (typeof previousExpoPublicFeaturePolicy === 'undefined') delete process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV;
      else process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV = previousExpoPublicFeaturePolicy;
      if (typeof previousExpoPublicBuildFeaturesAllow === 'undefined') delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
      else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = previousExpoPublicBuildFeaturesAllow;
      if (typeof previousExpoPublicBuildFeaturesDeny === 'undefined') delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
      else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousExpoPublicBuildFeaturesDeny;
      if (typeof previousFeaturePolicyEnv === 'undefined') delete process.env.HAPPIER_FEATURE_POLICY_ENV;
      else process.env.HAPPIER_FEATURE_POLICY_ENV = previousFeaturePolicyEnv;
      if (typeof previousEmbeddedPolicyEnv === 'undefined') delete process.env.HAPPIER_EMBEDDED_POLICY_ENV;
      else process.env.HAPPIER_EMBEDDED_POLICY_ENV = previousEmbeddedPolicyEnv;
      if (typeof previousBuildFeaturesAllow === 'undefined') delete process.env.HAPPIER_BUILD_FEATURES_ALLOW;
      else process.env.HAPPIER_BUILD_FEATURES_ALLOW = previousBuildFeaturesAllow;
      if (typeof previousBuildFeaturesDeny === 'undefined') delete process.env.HAPPIER_BUILD_FEATURES_DENY;
      else process.env.HAPPIER_BUILD_FEATURES_DENY = previousBuildFeaturesDeny;
    }
  });
});

test('withStackEnv omits a stale caller browser Artifact origin when the stack has no explicit value', async () => {
  await withTempStackEnvFixture(async ({ stackName }) => {
    const previousArtifactOrigin = process.env.HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN;
    process.env.HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN = 'https://stale-artifacts.localhost';

    try {
      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          assert.equal(env.HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN, undefined);
        },
      });
    } finally {
      if (typeof previousArtifactOrigin === 'undefined') {
        delete process.env.HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN;
      } else {
        process.env.HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN = previousArtifactOrigin;
      }
    }
  });
});

test('withStackEnv keeps a Codex home scoped to the selected stack', async () => {
  await withTempStackEnvFixture(async ({ stackName, storageDir }) => {
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/tmp/other-stack/connected-services/materialized/codex/codex-home';

    try {
      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          assert.equal(env.CODEX_HOME, undefined);
        },
      });

      const configuredCodexHome = join(storageDir, stackName, 'native-codex-home');
      await writeFile(
        join(storageDir, stackName, 'env'),
        [
          'HAPPIER_STACK_REPO_DIR=/tmp/happier',
          `HAPPIER_STACK_CLI_HOME_DIR=${join(storageDir, stackName, 'cli')}`,
          'HAPPIER_STACK_SERVER_PORT=3555',
          `CODEX_HOME=${configuredCodexHome}`,
          '',
        ].join('\n'),
        'utf-8',
      );

      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          assert.equal(env.CODEX_HOME, configuredCodexHome);
        },
      });
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });
});

test('withStackEnv scrubs declared Agent homes while preserving stack-explicit homes', async () => {
  await withTempStackEnvFixture(async ({ stackName, storageDir }) => {
    const keys = ['CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) process.env[key] = '/tmp/foreign-agent-home';

    try {
      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          for (const key of keys) assert.ok(env[key] === undefined, `${key} must be scrubbed`);
        },
      });
      await writeFile(join(storageDir, stackName, 'env'), [
        `HAPPIER_STACK_CLI_HOME_DIR=${join(storageDir, stackName, 'cli')}`,
        ...keys.map((key) => `${key}=${join(storageDir, stackName, key)}`),
        '',
      ].join('\n'), 'utf8');
      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          for (const key of keys) assert.ok(env[key] === join(storageDir, stackName, key), `${key} must be stack-scoped`);
        },
      });
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});

test('withStackEnv passes through a browser Artifact origin only from its stack env file', async () => {
  await withTempStackEnvFixture(async ({ stackName, storageDir }) => {
    const artifactOrigin = 'https://artifacts.sanitize.test';
    await writeFile(
      join(storageDir, stackName, 'env'),
      [
        'HAPPIER_STACK_REPO_DIR=/tmp/happier',
        `HAPPIER_STACK_CLI_HOME_DIR=${join(storageDir, stackName, 'cli')}`,
        'HAPPIER_STACK_SERVER_PORT=3555',
        `HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN=${artifactOrigin}`,
        '',
      ].join('\n'),
      'utf-8',
    );
    const previousArtifactOrigin = process.env.HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN;
    process.env.HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN = 'https://stale-artifacts.localhost';

    try {
      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          assert.equal(env.HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN, artifactOrigin);
        },
      });
    } finally {
      if (typeof previousArtifactOrigin === 'undefined') {
        delete process.env.HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN;
      } else {
        process.env.HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN = previousArtifactOrigin;
      }
    }
  });
});

test('withStackEnv ignores runtime ports backed only by an untrusted live pid', async () => {
  await withTempStackEnvFixture(
    async ({ stackName, storageDir }) => {
      await writeFile(
        join(storageDir, stackName, 'stack.runtime.json'),
        JSON.stringify({
          version: 1,
          stackName,
          ephemeral: true,
          ports: { server: 4666 },
          processes: { serverPid: process.pid },
        }) + '\n',
        'utf-8',
      );

      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          assert.equal(env.HAPPIER_STACK_SERVER_PORT, undefined);
          assert.equal(env.HAPPIER_STACK_EPHEMERAL_PORTS, undefined);
        },
      });
    },
    { includeServerPort: false },
  );
});

test('stack endpoint resolver ignores runtime ports backed only by an untrusted live pid', async () => {
  await withTempStackEnvFixture(
    async ({ stackName, storageDir }) => {
      await writeFile(
        join(storageDir, stackName, 'stack.runtime.json'),
        JSON.stringify({
          version: 1,
          stackName,
          ephemeral: true,
          ports: { server: 4888 },
          processes: { serverPid: process.pid },
        }) + '\n',
        'utf-8',
      );

      assert.equal((await resolveStackServerEndpoint({ stackName })).runtimePort, null);
    },
    { includeServerPort: false },
  );
});

test('withStackEnv applies runtime ports backed by a trusted live stack pid', async (t) => {
  await withTempStackEnvFixture(
    async ({ stackName, storageDir }) => {
      const envPath = join(storageDir, stackName, 'env');
      const cliHomeDir = join(storageDir, stackName, 'cli');
      const child = spawn(process.execPath, ['-e', `
        const http = require('node:http');
        const server = http.createServer((req, res) => {
          if (req.url === '/health' || req.url === '/ready') {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
            return;
          }
          res.statusCode = 404;
          res.end('not found');
        });
        server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
        setInterval(() => {}, 1000);
      `], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          HAPPIER_STACK_STACK: stackName,
          HAPPIER_STACK_ENV_FILE: envPath,
          HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
          HAPPIER_STACK_PROCESS_KIND: 'server',
        },
      });
      t.after(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      });
      const childPort = await new Promise((resolve, reject) => {
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
          const value = Number(output.split(/\r?\n/).find(Boolean));
          if (Number.isInteger(value) && value > 0) resolve(value);
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`runtime server exited early (${code ?? 'unknown'})`)));
      });

      await writeFile(
        join(storageDir, stackName, 'stack.runtime.json'),
        JSON.stringify({
          version: 1,
          stackName,
          ephemeral: true,
          ports: { server: childPort },
          processes: { serverPid: child.pid },
        }) + '\n',
        'utf-8',
      );

      const originalPath = process.env.PATH;
      const listenerReadsPath = join(storageDir, 'listener-reads');
      if (process.platform === 'linux') {
        const ssPath = await resolveCommandPath('ss');
        assert.ok(ssPath, 'Linux listener fixture requires ss');
        const binDir = join(storageDir, 'observed-listener-tools');
        await mkdir(binDir);
        // Genuine OS boundary: retain the real socket scan and record its cost.
        await writeFile(join(binDir, 'ss'), `#!/bin/sh\nprintf 'scan\\n' >> '${listenerReadsPath}'\nexec '${ssPath}' "$@"\n`);
        await chmod(join(binDir, 'ss'), 0o755);
        process.env.PATH = `${binDir}:${originalPath ?? ''}`;
      }
      try {
        await withStackEnv({
          stackName,
          fn: async ({ env }) => {
            assert.equal(env.HAPPIER_STACK_SERVER_PORT, String(childPort));
            assert.equal(env.HAPPIER_STACK_EPHEMERAL_PORTS, '1');
          },
        });
        if (process.platform === 'linux') {
          assert.equal((await readFile(listenerReadsPath, 'utf8')).trim().split('\n').length, 1,
            'one environment projection must reuse its server listener observation');
        }
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
      assert.equal((await resolveStackServerEndpoint({ stackName })).runtimePort, childPort);

      if (process.platform !== 'win32') {
        // Genuine OS boundaries: neither a slow lsof nor ss can prove ownership.
        // Scoped environment construction must still permit process teardown,
        // while the real endpoint owner must refuse routing to another port.
        const binDir = join(storageDir, 'slow-listener-tools');
        await mkdir(binDir);
        for (const tool of ['lsof', 'ss']) {
          const path = join(binDir, tool);
          await writeFile(path, '#!/bin/sh\nexec /bin/sleep 6\n', 'utf8');
          await chmod(path, 0o755);
        }
        const previousPath = process.env.PATH;
        process.env.PATH = `${binDir}:${previousPath ?? ''}`;
        try {
          const scoped = await withStackEnv({
            stackName,
            fn: async ({ env, runtimeState }) => ({
              serverPort: env.HAPPIER_STACK_SERVER_PORT,
              ephemeralOverlay: env.HAPPIER_STACK_EPHEMERAL_PORTS,
              scope: env.HAPPIER_ACTIVE_SERVER_ID,
              serverPid: runtimeState.processes.serverPid,
            }),
          });
          assert.equal(scoped.serverPort, undefined);
          assert.equal(scoped.ephemeralOverlay, undefined);
          assert.equal(scoped.scope, 'stack_sanitize__id_default');
          assert.equal(scoped.serverPid, child.pid);
          await assert.rejects(resolveStackServerEndpoint({ stackName }), {
            code: 'ELISTENERDISCOVERYINCONCLUSIVE',
          });
        } finally {
          if (previousPath === undefined) delete process.env.PATH;
          else process.env.PATH = previousPath;
        }
      }
    },
    { includeServerPort: false },
  );
});

test('withStackEnv preserves explicit local stack runtime override env vars from caller scope', async () => {
  await withTempStackEnvFixture(async ({ stackName }) => {
    const previousCliBuild = process.env.HAPPIER_STACK_CLI_BUILD;
    const previousSkipRefreshDeps = process.env.HAPPIER_STACK_SKIP_REFRESH_DEPS;
    const previousSyncBundledWorkspaces = process.env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES;
    const previousExpoExportMaxWorkers = process.env.HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS;

    process.env.HAPPIER_STACK_CLI_BUILD = '0';
    process.env.HAPPIER_STACK_SKIP_REFRESH_DEPS = '1';
    process.env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES = '0';
    process.env.HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS = '2';

    try {
      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          assert.equal(env.HAPPIER_STACK_CLI_BUILD, '0');
          assert.equal(env.HAPPIER_STACK_SKIP_REFRESH_DEPS, '1');
          assert.equal(env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES, '0');
          assert.equal(env.HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS, '2');
        },
      });
    } finally {
      if (typeof previousCliBuild === 'undefined') delete process.env.HAPPIER_STACK_CLI_BUILD;
      else process.env.HAPPIER_STACK_CLI_BUILD = previousCliBuild;
      if (typeof previousSkipRefreshDeps === 'undefined') delete process.env.HAPPIER_STACK_SKIP_REFRESH_DEPS;
      else process.env.HAPPIER_STACK_SKIP_REFRESH_DEPS = previousSkipRefreshDeps;
      if (typeof previousSyncBundledWorkspaces === 'undefined') delete process.env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES;
      else process.env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES = previousSyncBundledWorkspaces;
      if (typeof previousExpoExportMaxWorkers === 'undefined') delete process.env.HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS;
      else process.env.HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS = previousExpoExportMaxWorkers;
    }
  });
});

test('withStackEnv preserves an explicit package cache root while scrubbing unrelated caller stack vars', async () => {
  await withTempStackEnvFixture(async ({ stackName, storageDir }) => {
    const keys = [
      'HAPPIER_STACK_PM_CACHE_BASE_DIR',
      'YARN_CACHE_FOLDER',
      'HAPPIER_STACK_UNRELATED_CALLER_VALUE',
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const cacheBaseDir = join(storageDir, 'remote-package-cache');

    process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR = cacheBaseDir;
    delete process.env.YARN_CACHE_FOLDER;
    process.env.HAPPIER_STACK_UNRELATED_CALLER_VALUE = 'must-not-leak';

    try {
      await withStackEnv({
        stackName,
        reconcileDaemonRuntimeState: false,
        fn: async ({ env }) => {
          assert.equal(env.HAPPIER_STACK_PM_CACHE_BASE_DIR, cacheBaseDir);
          assert.equal(env.HAPPIER_STACK_UNRELATED_CALLER_VALUE, undefined);

          const packageManagerEnv = await applyStackCacheEnv(env);
          assert.equal(packageManagerEnv.YARN_CACHE_FOLDER, join(cacheBaseDir, 'yarn'));
        },
      });
    } finally {
      for (const key of keys) {
        if (typeof previous[key] === 'undefined') delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});

test('withStackEnv replaces a foreign daemon lifecycle scope with the selected stack scope', async () => {
  await withTempStackEnvFixture(async ({ stackName }) => {
    const previousActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;
    const previousLifecycleScopeId = process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'stack_other__id_default';
    process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID = 'stack_other__id_default';

    try {
      await withStackEnv({
        stackName,
        reconcileDaemonRuntimeState: false,
        fn: async ({ env }) => {
          assert.equal(env.HAPPIER_ACTIVE_SERVER_ID, 'stack_sanitize__id_default');
          assert.equal(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID, 'stack_sanitize__id_default');
        },
      });
    } finally {
      if (typeof previousActiveServerId === 'undefined') delete process.env.HAPPIER_ACTIVE_SERVER_ID;
      else process.env.HAPPIER_ACTIVE_SERVER_ID = previousActiveServerId;
      if (typeof previousLifecycleScopeId === 'undefined') delete process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID;
      else process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID = previousLifecycleScopeId;
    }
  });
});

test('withStackEnv preserves runtime mode when the caller already targets the selected stack', async () => {
  await withTempStackEnvFixture(async ({ stackName }) => {
    const keys = ['HAPPIER_STACK_STACK', 'HAPPIER_STACK_RUNTIME_MODE'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

    process.env.HAPPIER_STACK_STACK = stackName;
    process.env.HAPPIER_STACK_RUNTIME_MODE = 'require';

    try {
      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          assert.equal(env.HAPPIER_STACK_RUNTIME_MODE, 'require');
        },
      });
    } finally {
      for (const key of keys) {
        if (typeof previous[key] === 'undefined') delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});

test('withStackEnv does not carry foreign stack runtime or Expo selections into the selected stack', async () => {
  await withTempStackEnvFixture(async ({ stackName, storageDir }) => {
    const keys = [
      'HAPPIER_STACK_STACK',
      'HAPPIER_STACK_ENV_FILE',
      'HAPPIER_STACK_RUNTIME_MODE',
      'HAPPIER_STACK_EXPO_SOURCE_STACK',
      'HAPPIER_STACK_EXPO_DEV_PORT',
      'HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY',
      'HAPPIER_STACK_EXPO_DEV_PORT_BASE',
      'HAPPIER_STACK_EXPO_DEV_PORT_RANGE',
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

    process.env.HAPPIER_STACK_STACK = 'source-stack';
    process.env.HAPPIER_STACK_ENV_FILE = join(storageDir, 'source-stack', 'env');
    process.env.HAPPIER_STACK_RUNTIME_MODE = 'require';
    process.env.HAPPIER_STACK_EXPO_SOURCE_STACK = 'source-expo-owner';
    process.env.HAPPIER_STACK_EXPO_DEV_PORT = '18829';
    process.env.HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY = 'stable';
    process.env.HAPPIER_STACK_EXPO_DEV_PORT_BASE = '18081';
    process.env.HAPPIER_STACK_EXPO_DEV_PORT_RANGE = '2000';

    try {
      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          assert.equal(env.HAPPIER_STACK_STACK, stackName);
          assert.equal(env.HAPPIER_STACK_RUNTIME_MODE, undefined);
          assert.equal(env.HAPPIER_STACK_EXPO_SOURCE_STACK, undefined);
          assert.equal(env.HAPPIER_STACK_EXPO_DEV_PORT, undefined);
          assert.equal(env.HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY, undefined);
          assert.equal(env.HAPPIER_STACK_EXPO_DEV_PORT_BASE, undefined);
          assert.equal(env.HAPPIER_STACK_EXPO_DEV_PORT_RANGE, undefined);
        },
      });
    } finally {
      for (const key of keys) {
        if (typeof previous[key] === 'undefined') delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});
