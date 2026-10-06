import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextIoTurn } from 'node:timers/promises';

import { createProbeTempDir } from '@/capabilities/probes/agentModelsProbe.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { reloadConfiguration } from '@/configuration';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { detectCliSnapshotOnDaemonPath as detect, invalidateCliSnapshots as invalidate, type DetectCliRequest } from './cliSnapshot';

const ENV_KEYS = [
  'HOME', 'USERPROFILE', 'PATH', 'HAPPIER_HOME_DIR', 'HAPPIER_OPENCODE_PATH', 'HAPPIER_CODEX_PATH',
  'HAPPIER_CLAUDE_PATH', 'HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON', 'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS', 'HAPPIER_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY',
] as const;

describe('detectCliSnapshotOnDaemonPath (cache)', () => {
  let fixture: Awaited<ReturnType<typeof createProbeTempDir>>;
  let nativeRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  let baseline: ReturnType<typeof snapshotEnvValues>;
  let binDir: string;
  let countFile: string;

  beforeEach(async () => {
    fixture = await createProbeTempDir('happier-cli-snapshot-cache');
    baseline = snapshotEnvValues(ENV_KEYS);
    binDir = join(fixture.dir, 'bin');
    countFile = join(fixture.dir, 'invocations');
    await mkdir(binDir, { recursive: true });
    await writeFile(countFile, '');
    applyEnvValues(Object.fromEntries(ENV_KEYS.map((key) => [key, undefined])));
    applyEnvValues({ HOME: fixture.dir, USERPROFILE: fixture.dir, HAPPIER_HOME_DIR: fixture.dir,
      PATH: binDir, HAPPIER_JS_RUNTIME_PATH: process.execPath });
    reloadConfiguration();
    invalidate();
  });

  afterEach(async () => {
    vi.useRealTimers();
    invalidate();
    restoreEnvValues(baseline);
    try {
      reloadConfiguration();
    } finally {
      await fixture.cleanup();
    }
  });

  afterAll(async () => {
    await nativeRuntime?.dispose();
  });

  async function cli(name: string, body = 'process.stdout.write("1.2.3\\n");', directory = binDir) {
    const scriptPath = join(directory, name + '.js');
    await mkdir(directory, { recursive: true });
    await writeFile(scriptPath, [
      'const fs = require("node:fs");',
      'fs.appendFileSync(' + JSON.stringify(countFile) + ', "1");', body,
    ].join('\n'));
    // OpenCode promises a native executable override, not a JavaScript-file override.
    const path = await writeExecutableShim({
      dir: directory,
      fileName: process.platform === 'win32' ? name + '.cmd' : name,
      contents: process.platform === 'win32'
        ? '@echo off\r\n"' + process.execPath + '" "' + scriptPath + '" %*\r\n'
        : '#!/bin/sh\nexec "' + process.execPath + '" "' + scriptPath + '" "$@"\n',
    });
    applyEnvValues({ ['HAPPIER_' + name.toUpperCase() + '_PATH']: path });
    return path;
  }

  const request = (name = 'opencode', includeLoginStatus = false): DetectCliRequest => ({
    requestedCliNames: [name], includeLoginStatus,
  });
  const invocations = async () => (await readFile(countFile, 'utf8')).length;

  it('returns a timed-out auth status instead of hanging when a CLI auth probe never settles', async () => {
    const startedFile = join(fixture.dir, 'auth-started');
    await cli('opencode', [
      'if (process.argv.includes("auth")) {',
      'fs.writeFileSync(' + JSON.stringify(startedFile) + ', "started");',
      'setInterval(() => {}, 1000000);',
      '} else process.stdout.write("1.2.3\\n");',
    ].join('\n'));
    nativeRuntime ??= await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
    });
    process.env.HAPPIER_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS = '25';
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = detect({ ...request('opencode', true), bypassCache: true }).then((value) => { settled = true; return value; });
    // Keep real filesystem/process scheduling; only the external clock is controlled.
    while (!existsSync(startedFile) && !settled) await nextIoTurn();
    expect(existsSync(startedFile)).toBe(true);
    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const snapshot = await pending;
    expect(snapshot.clis.opencode.available).toBe(true);
    expect(snapshot.clis.opencode.isLoggedIn).toBeNull();
    expect(snapshot.clis.opencode.authStatus).toMatchObject({ state: 'unknown', reason: 'timeout' });
    // Settle the admitted command owner's own deadline before restoring the clock.
    await vi.runOnlyPendingTimersAsync();
  }, 20_000);

  it('only probes auth for requested CLI names when the request is provider-scoped', async () => {
    const otherFile = join(fixture.dir, 'unselected-codex');
    await cli('opencode', 'process.stdout.write(process.argv.includes("auth") ? "openai alice@example.com default\\n" : "1.2.3\\n");');
    await cli('codex', 'fs.writeFileSync(' + JSON.stringify(otherFile) + ', "invoked"); process.stdout.write("1.2.3\\n");');
    nativeRuntime ??= await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
    });
    const snapshot = await detect({ ...request('opencode', true), bypassCache: true });
    expect(snapshot.clis.opencode.isLoggedIn).toBe(true);
    expect(snapshot.clis.opencode.authStatus).toMatchObject({ state: 'logged_in', method: 'oauth_cli', source: 'command' });
    expect(existsSync(otherFile)).toBe(false);
  }, 20_000);

  it('allows slower successful auth probes to complete before the snapshot timeout', async () => {
    await cli('opencode', [
      'if (process.argv.includes("auth")) setTimeout(() => process.stdout.write("openai alice@example.com default\\n"), 1700);',
      'else process.stdout.write("1.2.3\\n");',
    ].join('\n'));
    nativeRuntime ??= await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
    });
    const snapshot = await detect({ ...request('opencode', true), bypassCache: true });
    expect(snapshot.clis.opencode.available).toBe(true);
    expect(snapshot.clis.opencode.isLoggedIn).toBe(true);
    expect(snapshot.clis.opencode.authStatus).toMatchObject({ state: 'logged_in', method: 'oauth_cli', source: 'command' });
  }, 20_000);

  it('caches snapshots and avoids re-probing within TTL', async () => {
    await cli('opencode');
    await detect(request());
    const first = await invocations();
    await detect(request());
    expect(await invocations()).toBe(first);
    await detect(request('opencode', true));
    expect(await invocations()).toBeGreaterThan(first);
  }, 20_000);

  it('reports what is installed now after an update invalidates the cached snapshots', async () => {
    await cli('opencode');
    expect((await detect(request())).clis.opencode.version).toBe('1.2.3');
    await cli('opencode', 'process.stdout.write("1.2.4\\n");');
    invalidate();
    expect((await detect(request())).clis.opencode.version).toBe('1.2.4');
  }, 20_000);

  it('invalidates cache when HAPPIER_*_PATH override changes', async () => {
    await cli('opencode');
    await detect(request());
    const first = await invocations();
    await detect(request());
    expect(await invocations()).toBe(first);
    await cli('opencode', 'process.stdout.write("1.2.4\\n");', join(fixture.dir, 'other-bin'));
    const changed = await detect(request());
    expect(changed.clis.opencode.version).toBe('1.2.4');
    const afterChange = await invocations();
    expect(afterChange).toBeGreaterThan(first);
    await detect(request());
    expect(await invocations()).toBe(afterChange);
  }, 20_000);

  it.each(['HAPPIER_HOME_DIR', 'HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON'] as const)(
    'invalidates cache when %s changes', async (key) => {
      await cli('opencode');
      await detect(request());
      const first = await invocations();
      await detect(request());
      expect(await invocations()).toBe(first);
      process.env[key] = key === 'HAPPIER_HOME_DIR'
        ? join(fixture.dir, 'other-home') : JSON.stringify({ opencode: 'managed-first' });
      await detect(request());
      expect(await invocations()).toBeGreaterThan(first);
    }, 20_000,
  );

  it('invalidates cache when auth environment changes login status', async () => {
    await cli('claude');
    const first = await detect(request('claude', true));
    const firstCount = await invocations();
    expect(first.clis.claude.isLoggedIn).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const second = await detect(request('claude', true));
    expect(second.clis.claude.isLoggedIn).toBe(true);
    expect(second.clis.claude.authStatus).toMatchObject({ state: 'logged_in', method: 'api_key_env', source: 'env' });
    expect(await invocations()).toBeGreaterThan(firstCount);
  }, 20_000);

  it('invalidates cache when HOME changes auth-file lookup', async () => {
    await cli('claude');
    const homeB = join(fixture.dir, 'home-b');
    await mkdir(join(homeB, '.claude'), { recursive: true });
    await writeFile(join(homeB, '.claude', '.credentials.json'), JSON.stringify({ accessToken: 'token' }));
    const first = await detect(request('claude', true));
    const firstCount = await invocations();
    expect(first.clis.claude.isLoggedIn).toBe(false);
    process.env.HOME = homeB;
    process.env.USERPROFILE = homeB;
    const second = await detect(request('claude', true));
    expect(second.clis.claude.isLoggedIn).toBe(true);
    expect(second.clis.claude.authStatus).toMatchObject({ state: 'logged_in', method: 'credentials_file', source: 'file' });
    expect(await invocations()).toBeGreaterThan(firstCount);
  }, 20_000);
});
