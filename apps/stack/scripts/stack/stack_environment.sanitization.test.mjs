import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getRuntimePortExtraEnv, withStackEnv } from './stack_environment.mjs';
import { applyStackCacheEnv } from '../utils/proc/pm.mjs';

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

test('getRuntimePortExtraEnv ignores runtime ports backed only by an untrusted live pid', async () => {
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

      assert.equal(await getRuntimePortExtraEnv(stackName), null);
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

      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          assert.equal(env.HAPPIER_STACK_SERVER_PORT, String(childPort));
          assert.equal(env.HAPPIER_STACK_EPHEMERAL_PORTS, '1');
        },
      });
      assert.deepEqual(await getRuntimePortExtraEnv(stackName), {
        HAPPIER_STACK_SERVER_PORT: String(childPort),
      });
    },
    { includeServerPort: false },
  );
});

test('withStackEnv preserves explicit local stack runtime override env vars from caller scope', async () => {
  await withTempStackEnvFixture(async ({ stackName }) => {
    const previousCliBuild = process.env.HAPPIER_STACK_CLI_BUILD;
    const previousSkipRefreshDeps = process.env.HAPPIER_STACK_SKIP_REFRESH_DEPS;
    const previousSyncBundledWorkspaces = process.env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES;

    process.env.HAPPIER_STACK_CLI_BUILD = '0';
    process.env.HAPPIER_STACK_SKIP_REFRESH_DEPS = '1';
    process.env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES = '0';

    try {
      await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          assert.equal(env.HAPPIER_STACK_CLI_BUILD, '0');
          assert.equal(env.HAPPIER_STACK_SKIP_REFRESH_DEPS, '1');
          assert.equal(env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES, '0');
        },
      });
    } finally {
      if (typeof previousCliBuild === 'undefined') delete process.env.HAPPIER_STACK_CLI_BUILD;
      else process.env.HAPPIER_STACK_CLI_BUILD = previousCliBuild;
      if (typeof previousSkipRefreshDeps === 'undefined') delete process.env.HAPPIER_STACK_SKIP_REFRESH_DEPS;
      else process.env.HAPPIER_STACK_SKIP_REFRESH_DEPS = previousSkipRefreshDeps;
      if (typeof previousSyncBundledWorkspaces === 'undefined') delete process.env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES;
      else process.env.HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES = previousSyncBundledWorkspaces;
    }
  });
});

test('withStackEnv preserves an explicit package cache root while scrubbing unrelated caller stack vars', async () => {
  await withTempStackEnvFixture(async ({ stackName, storageDir }) => {
    const keys = [
      'HAPPIER_STACK_PM_CACHE_BASE_DIR',
      'HAPPIER_STACK_UNRELATED_CALLER_VALUE',
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const cacheBaseDir = join(storageDir, 'remote-package-cache');

    process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR = cacheBaseDir;
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
