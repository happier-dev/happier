import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createSpawnHappyCliEnvScope } from '@/testkit/process/spawnHappyCliHarness';
import {
  PLUGIN_FAILURE_TEXT_MAX_UTF8_BYTES,
  projectPluginFailureText,
} from '@/plugins/runtime/lifecycle/utils';

import { runPackedPluginTest } from './packedTest';

it('preserves a typed daemon failure before packed install-and-trust review', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-packed-failure-source-'));
  const fakeDaemonEntrypoint = join(sourceRoot, 'fake-packed-daemon.mjs');
  const envScope = createSpawnHappyCliEnvScope();
  const pluginId = 'acme.packed-failure-diagnostic';
  const daemonFailureMessage = [
    'Fixture daemon rejected the archive',
    'client_secret=packed-daemon-secret',
    'at /Users/fixture/private/archive.tgz',
    'x'.repeat(PLUGIN_FAILURE_TEXT_MAX_UTF8_BYTES * 2),
  ].join(' ');
  const projectedDaemonFailureMessage = projectPluginFailureText(
    new Error(daemonFailureMessage),
  );

  try {
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(sourceRoot, 'daemon.mjs'), [
      'export async function activate(api) {',
      '  api.actions.register("verify", async () => ({ verified: true }));',
      '}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(
      join(sourceRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify(createPluginManifestV2Fixture({
        id: pluginId,
        displayName: 'Packed Failure Diagnostic',
        activation: { events: [{ kind: 'startup' }] },
        contributes: {
          actions: [{
            id: 'verify',
            title: 'Verify',
            scopes: ['global'],
            surfaces: ['cli'],
            execution: { target: 'daemon' },
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
          }],
        },
      }), null, 2),
      'utf8',
    );
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'acme-packed-failure-diagnostic',
      version: '1.0.0',
      keywords: ['happier-plugin'],
      files: ['.happier-plugin', 'daemon.mjs'],
      happier: { manifest: '.happier-plugin/plugin.json' },
    }), 'utf8');
    await writeFile(fakeDaemonEntrypoint, [
      "import { createServer } from 'node:http';",
      "import { writeFile } from 'node:fs/promises';",
      '',
      'const args = process.argv.slice(2);',
      'const readyIndex = args.indexOf("--ready-file");',
      'const readyFile = readyIndex >= 0 ? args[readyIndex + 1] : null;',
      'if (!readyFile) throw new Error("Missing packed daemon ready file");',
      '',
      'const server = createServer((request, response) => {',
      '  if (request.headers["x-happier-daemon-token"] !== "fixture-control-token") {',
      '    response.writeHead(401);',
      '    response.end();',
      '    return;',
      '  }',
      '  response.writeHead(200, { "content-type": "application/json" });',
      '  response.end(JSON.stringify({',
      '    kind: "failed",',
      '    code: "fixture_daemon_change_failed",',
      `    message: ${JSON.stringify(daemonFailureMessage)},`,
      '    pluginId: "acme.daemon-reported-untrusted-plugin",',
      '    expectedCandidate: "/Users/fixture/private/candidate.tgz",',
      '  }));',
      '});',
      'server.listen(0, "127.0.0.1", () => {',
      '  const address = server.address();',
      '  if (!address || typeof address === "string") throw new Error("Missing daemon address");',
      '  void writeFile(readyFile, JSON.stringify({',
      '    kind: "happier_packed_test_daemon_ready_v1",',
      '    pid: process.pid,',
      '    httpPort: address.port,',
      '    controlToken: "fixture-control-token",',
      '    incarnationId: "fixture-incarnation",',
      '  }) + "\\n", "utf8");',
      '});',
      'process.once("SIGTERM", () => server.close(() => process.exit(0)));',
      '',
    ].join('\n'), 'utf8');
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: fakeDaemonEntrypoint,
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
      HAPPIER_VARIANT: undefined,
      HAPPIER_STACK_REPO_DIR: undefined,
      HAPPIER_STACK_CLI_ROOT_DIR: undefined,
      HAPPIER_STACK_STACK: undefined,
    });

    const result = await runPackedPluginTest({ projectRoot: sourceRoot });

    expect(result).toMatchObject({ ok: false, mode: 'packed' });
    if (result.ok) throw new Error('Expected the fake daemon to reject packed installation');
    const diagnostic = result.diagnostics[0];
    if (!diagnostic) throw new Error('Expected one packed install diagnostic');

    expect(diagnostic.code).toBe('plugin_packed_install_review_missing');
    expect(diagnostic.message).toBe(
      `Disposable daemon returned 'failed' before Install and trust for '${sourceRoot}' (`
      + `failed:fixture_daemon_change_failed:${projectedDaemonFailureMessage})`,
    );
    expect(diagnostic.message).not.toContain('packed-daemon-secret');
    expect(diagnostic.message).not.toContain('/Users/fixture/private/archive.tgz');
    expect(diagnostic.message).not.toContain('/Users/fixture/private/candidate.tgz');
    expect(Buffer.byteLength(projectedDaemonFailureMessage, 'utf8')).toBeLessThanOrEqual(
      PLUGIN_FAILURE_TEXT_MAX_UTF8_BYTES,
    );
  } finally {
    envScope.restore();
    await rm(sourceRoot, { recursive: true, force: true });
  }
}, 60_000);

it('redacts a daemon startup failure emitted before packed readiness', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-packed-startup-failure-source-'));
  const fakeDaemonEntrypoint = join(sourceRoot, 'fake-packed-daemon-startup-failure.mjs');
  const envScope = createSpawnHappyCliEnvScope();
  const pluginId = 'acme.packed-startup-failure-diagnostic';
  const daemonStartupFailure = [
    'Fixture daemon could not start',
    'client_secret=packed-startup-secret',
    'at /Users/fixture/private/startup.mjs:12:3',
    'x'.repeat(PLUGIN_FAILURE_TEXT_MAX_UTF8_BYTES * 2),
  ].join(' ');
  const projectedDaemonStartupFailure = projectPluginFailureText(
    new Error(`Disposable plugin daemon exited before readiness: ${daemonStartupFailure}`),
  );

  try {
    await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(sourceRoot, 'daemon.mjs'), [
      'export async function activate(api) {',
      '  api.actions.register("verify", async () => ({ verified: true }));',
      '}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(
      join(sourceRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify(createPluginManifestV2Fixture({
        id: pluginId,
        displayName: 'Packed Startup Failure Diagnostic',
        activation: { events: [{ kind: 'startup' }] },
        contributes: {
          actions: [{
            id: 'verify',
            title: 'Verify',
            scopes: ['global'],
            surfaces: ['cli'],
            execution: { target: 'daemon' },
            placementBindings: ['commandPalette'],
            dangerLevel: 'safe',
          }],
        },
      }), null, 2),
      'utf8',
    );
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'acme-packed-startup-failure-diagnostic',
      version: '1.0.0',
      keywords: ['happier-plugin'],
      files: ['.happier-plugin', 'daemon.mjs'],
      happier: { manifest: '.happier-plugin/plugin.json' },
    }), 'utf8');
    await writeFile(fakeDaemonEntrypoint, [
      `process.stderr.write(${JSON.stringify(daemonStartupFailure)} + "\\n");`,
      'setTimeout(() => process.exit(17), 50);',
      '',
    ].join('\n'), 'utf8');
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: fakeDaemonEntrypoint,
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
      HAPPIER_VARIANT: undefined,
      HAPPIER_STACK_REPO_DIR: undefined,
      HAPPIER_STACK_CLI_ROOT_DIR: undefined,
      HAPPIER_STACK_STACK: undefined,
    });

    const result = await runPackedPluginTest({ projectRoot: sourceRoot });

    expect(result).toMatchObject({ ok: false, mode: 'packed' });
    if (result.ok) throw new Error('Expected the fake daemon to fail before readiness');
    const diagnostic = result.diagnostics[0];
    if (!diagnostic) throw new Error('Expected one packed startup diagnostic');

    expect(diagnostic.code).toBe('plugin_packed_test_failed');
    expect(diagnostic.message).toBe(projectedDaemonStartupFailure);
    expect(diagnostic.message).not.toContain('packed-startup-secret');
    expect(diagnostic.message).not.toContain('/Users/fixture/private/startup.mjs');
    expect(Buffer.byteLength(diagnostic.message, 'utf8')).toBeLessThanOrEqual(
      PLUGIN_FAILURE_TEXT_MAX_UTF8_BYTES,
    );
  } finally {
    envScope.restore();
    await rm(sourceRoot, { recursive: true, force: true });
  }
}, 60_000);
