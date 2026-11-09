import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, readdir, writeFile } from 'node:fs/promises';

import { describe, expect, it, onTestFailed, onTestFinished } from 'vitest';

import { projectPath } from '@/projectPath';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';
import { resolveCliTsxTsconfigPath } from '@/utils/spawnHappyCLI';

describe('daemon source imports', () => {
  it('keeps startup alive on declared HTTPS after an unknown native transport closure and records its typed reason', async () => {
    const cliRoot = projectPath();
    const sourceRuntimeUrl = pathToFileURL(join(cliRoot, '..', '..', 'packages', 'cli-common', 'registerSourceRuntime.mjs')).href;
    const axiosModuleUrl = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve('axios/package.json')), 'index.js')).href;
    await withTempDir('happier-daemon-unknown-closure-', async tempDir => {
      const addonPath = join(tempDir, 'native-boundary.cjs');
      // Only the native C ABI and HTTP boundaries are substituted. The loader,
      // runtime factory, classifier, startup, publication and logging stay real.
      await writeFile(addonPath, [
        'const ok = result => JSON.stringify({ ok: true, result });',
        'const endpoint = { endpointHandle: "fixture-endpoint", endpointId: "b".repeat(64), relayPolicy: "disabled", relayMode: "disabled", capProfile: "machineBulk", relayUrls: [] };',
        'module.exports = new Proxy({}, { get(_target, operation) { return async () => {',
        '  if (operation === "createEndpoint") return ok(endpoint);',
        '  if (operation === "getEndpointStatus") return ok({ ...endpoint, active: true, directAddresses: [], activeTunnelCount: 0, activeAcceptorCount: 0 });',
        '  if (operation === "ensureHomeTunnel") { globalThis.fixtureNativeDials = (globalThis.fixtureNativeDials ?? 0) + 1; return JSON.stringify({ ok: false, error: { code: "transport_closed", message: "private-native-closure-detail" } }); }',
        '  if (operation === "shutdownEndpoint") return ok(null);',
        '  throw new Error("Unexpected native operation: " + String(operation));',
        '} } });',
      ].join('\n'));
      const probePath = join(tempDir, 'unknown-closure-startup.ts');
      const sourceUrl = (path: string) => pathToFileURL(join(cliRoot, 'src', path)).href;
      await writeFile(probePath, [
        'import { registerHooks } from "node:module";',
        `registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(specifier.endsWith(".node") && specifier.includes("happier-iroh-native-lifecycle") ? ${JSON.stringify(addonPath)} : specifier, context); } });`,
        '(async () => {',
        `const { startDaemon } = await import(${JSON.stringify(sourceUrl('daemon/startDaemon.ts'))});`,
        `const { seedTestServerProfile } = await import(${JSON.stringify(sourceUrl('testkit/serverProfiles.ts'))});`,
        'const profile = await seedTestServerProfile({ id: "unknown-closure", homeId: "srv_startup_fixture", serverUrl: "https://home.example.test" });',
        `const { updateSettings, writeCredentialsTokenOnly } = await import(${JSON.stringify(sourceUrl('persistence.ts'))});`,
        'profile.homeConnectionDescriptor.endpoints.unshift({ kind: "iroh", endpointId: "a".repeat(64) });',
        'await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [profile.id]: profile } }));',
        'await writeCredentialsTokenOnly({ token: "fixture-startup-terminal" });',
        'globalThis.fetch = async () => new Response(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: "srv_startup_fixture" } } }), { status: 200, headers: { "content-type": "application/json" } });',
        // This probe lives in an OS temp directory, outside package resolution.
        `const { default: axios } = await import(${JSON.stringify(axiosModuleUrl)});`,
        `const { resolveServerHttpBaseUrl } = await import(${JSON.stringify(sourceUrl('api/client/serverHttpBaseUrl.ts'))});`,
        'axios.defaults.adapter = async config => {',
        '  if (new URL(config.url, config.baseURL).pathname === "/v1/auth/ping") return { data: {}, status: 200, statusText: "OK", headers: {}, config };',
        '  process.send({ phase: "bootstrap-http", runtimeOrigin: resolveServerHttpBaseUrl(), nativeDials: globalThis.fixtureNativeDials ?? 0 });',
        '  return await new Promise(() => {});',
        '};',
        'await startDaemon();',
        '})().catch(error => { process.send({ phase: "setup-failed", code: error?.code === "ERR_MODULE_NOT_FOUND" ? "module_not_found" : "setup_failed" }); process.exitCode = 2; process.disconnect?.(); });',
      ].join('\n'));
      const child = spawnTestProcess(process.execPath, ['--import', sourceRuntimeUrl, probePath, 'daemon', 'start-sync'], {
        cwd: cliRoot,
        env: { ...process.env, HAPPIER_HOME_DIR: tempDir, HAPPIER_ACTIVE_SERVER_ID: 'unknown-closure',
          HAPPIER_SERVER_URL: 'https://home.example.test', HAPPIER_PUBLIC_SERVER_URL: '',
          HAPPIER_LOCAL_SERVER_URL: '', HAPPIER_WEBAPP_URL: 'https://home.example.test',
          HAPPIER_HOME_CARRIER_POLICY: 'automatic', HAPPIER_IROH_RELAY_POLICY: 'disabled',
          HAPPIER_IROH_RELAY_URLS: '', HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
          HAPPIER_DAEMON_WAIT_FOR_AUTH: '0', TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath() },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const closed = once(child, 'close');
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      onTestFinished(async () => {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
      });
      const outcome = await Promise.race([
        once(child, 'message').then(([message]) => message),
        closed.then(([code]) => ({ phase: 'exited', code, stderr })),
      ]);
      expect(outcome).toEqual({ phase: 'bootstrap-http', runtimeOrigin: 'https://home.example.test', nativeDials: 1 });
      expect(child.exitCode).toBeNull();
      const logFiles = await readdir(join(tempDir, 'logs'));
      const logContent = (await Promise.all(logFiles.filter(file => file.endsWith('-daemon.log'))
        .map(file => readFile(join(tempDir, 'logs', file), 'utf8')))).join('\n');
      expect(logContent).toContain('transport_closed_unknown');
      expect(logContent).not.toContain('[DAEMON RUN][FATAL]');
      expect(logContent).not.toContain('private-native-closure-detail');
    });
  }, 90_000);

  it('emits fatal startup diagnostics to service stderr through real startup composition', async () => {
    const cliRoot = projectPath();
    const sourceRuntimeUrl = pathToFileURL(join(cliRoot, '..', '..', 'packages', 'cli-common', 'registerSourceRuntime.mjs')).href;
    await withTempDir('happier-daemon-fatal-stderr-', async tempDir => {
      const probePath = join(tempDir, 'fatal-startup.ts');
      const sourceUrl = (path: string) => pathToFileURL(join(cliRoot, 'src', path)).href;
      await writeFile(probePath, [
        '(async () => {',
        `const { startDaemon } = await import(${JSON.stringify(sourceUrl('daemon/startDaemon.ts'))});`,
        `const { seedTestServerProfile } = await import(${JSON.stringify(sourceUrl('testkit/serverProfiles.ts'))});`,
        'await seedTestServerProfile({ id: "fatal-startup", homeId: "srv_startup_fixture", serverUrl: "https://home.example.test" });',
        `const { writeCredentialsTokenOnly } = await import(${JSON.stringify(sourceUrl('persistence.ts'))});`,
        'await writeCredentialsTokenOnly({ token: "fixture-startup-terminal" });',
        // Only the network boundary is substituted. All startup, Home selection,
        // fatal cleanup, serialization and stderr output remain production code.
        'globalThis.fetch = async () => new Response(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: "srv_other_home" } } }), { status: 200, headers: { "content-type": "application/json" } });',
        'await startDaemon();',
        '})().catch(error => { console.error("probe setup failed", error); process.exit(2); });',
      ].join('\n'));
      const child = spawnTestProcess(process.execPath, ['--import', sourceRuntimeUrl, probePath, 'daemon', 'start-sync'], {
        cwd: cliRoot,
        env: { ...process.env, HAPPIER_HOME_DIR: tempDir, HAPPIER_ACTIVE_SERVER_ID: 'fatal-startup',
          HAPPIER_SERVER_URL: 'https://home.example.test', HAPPIER_PUBLIC_SERVER_URL: '',
          HAPPIER_LOCAL_SERVER_URL: '', HAPPIER_WEBAPP_URL: 'https://home.example.test',
          HAPPIER_HOME_CARRIER_POLICY: 'standard_only', HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
          HAPPIER_DAEMON_WAIT_FOR_AUTH: '0', TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const closed = once(child, 'close');
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      onTestFailed(async () => {
        console.error('Fatal startup probe stderr:', stderr);
        for (const file of await readdir(join(tempDir, 'logs')).catch(() => [])) {
          if (file.endsWith('.log')) console.error(await readFile(join(tempDir, 'logs', file), 'utf8'));
        }
      });
      onTestFinished(async () => {
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
      });
      const [code] = await closed;
      expect(code, stderr).toBe(1);
      const logFiles = await readdir(join(tempDir, 'logs'));
      const logContent = (await Promise.all(logFiles.filter(file => file.endsWith('-daemon.log'))
        .map(file => readFile(join(tempDir, 'logs', file), 'utf8')))).join('\n');
      expect(logContent).toContain('[DAEMON RUN][FATAL]');
      expect(logContent).toContain('Home identity did not match the expected profile');
      expect(stderr).toContain('Home identity did not match the expected profile');
      expect(stderr).toContain('stack');
      expect(stderr).not.toContain('fixture-startup-terminal');
    });
  }, 90_000);

  it.each([
    'daemon/startup/createDaemonMachineBootstrapRuntime.ts',
    'daemon/startDaemon.ts',
    'cli/commands/daemonControl.ts',
    '../scripts/build-owned/bundledPlugins/registry.ts',
    '../../../packages/protocol/src/workflows/builtins/openAPullRequest.ts',
  ])('loads %s through the TSX source loader without starting a daemon', async (entry) => {
    const cliRoot = projectPath();
    const tsconfigPath = resolveCliTsxTsconfigPath();
    const sourceRuntimeUrl = pathToFileURL(join(cliRoot, '..', '..', 'packages', 'cli-common', 'registerSourceRuntime.mjs')).href;
    const daemonBootstrapUrl = pathToFileURL(join(
      cliRoot,
      'src',
      entry,
    )).href;

    await withTempDir('happier-daemon-source-import-', async (tempDir) => {
      const probePath = join(tempDir, 'daemon-source-import.ts');
      await writeFile(
        probePath,
        [
          'import { registerHooks } from "node:module";',
          // Observe the real loader; do not replace any internal module. Builtin
          // authored data must load before a cyclic validator graph is ready.
          'registerHooks({ load(url, context, nextLoad) { if (url.split("?")[0].endsWith("/workflows/workflowV1.ts")) process.stdout.write("workflow-schema-evaluated\\n"); return nextLoad(url, context); } });',
          'registerHooks({ load(url, context, nextLoad) { if (/\\/ui\\/doctor(?:Snapshot)?\\.ts$/.test(url.split("?")[0])) throw new Error("Doctor diagnostics eagerly loaded before demand"); return nextLoad(url, context); } });',
          'const report = (phase) => process.stdout.write(JSON.stringify({ phase, uptimeMs: Math.round(process.uptime() * 1000), tsxCacheDisabled: process.env.TSX_DISABLE_CACHE === "1", resources: process.getActiveResourcesInfo() }) + "\\n");',
          'process.once("beforeExit", () => report("before-exit"));',
          '(async () => {',
          '  report("import-started");',
          `  await import(${JSON.stringify(daemonBootstrapUrl)});`,
          '  report("import-completed");',
          '})().catch((error) => {',
          '  console.error(error);',
          '  process.exitCode = 1;',
          '});',
        ].join('\n'),
        'utf8',
      );

      // Source checks must read the current workspace closure, not combine
      // source CLI imports with stale emitted dependency exports. The canonical
      // source preload owns TSX and its cache policy; this test owns only its probe.
      const child = spawnTestProcess(process.execPath, ['--import', sourceRuntimeUrl, probePath], {
        cwd: cliRoot,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: tsconfigPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const spawnedAtMs = performance.now();
      const closed = once(child, 'close');
      const diagnostics: string[] = [];
      child.stdout?.on('data', chunk => diagnostics.push(String(chunk)));
      child.stderr?.on('data', chunk => diagnostics.push(String(chunk)));
      onTestFailed(() => {
        console.error('Daemon source import probe:', {
          parentElapsedSinceSpawnMs: Math.round(performance.now() - spawnedAtMs),
        });
        console.error(diagnostics.join(''));
      });
      onTestFinished(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await closed;
        }
      });
      const [code] = await closed;
      expect(code, diagnostics.join('')).toBe(0);
      expect(diagnostics.join('')).toContain('"phase":"import-completed"');
      expect(diagnostics.join('')).toContain('"phase":"before-exit"');
      if (entry.endsWith('/builtins/openAPullRequest.ts')) {
        expect(diagnostics.join('')).not.toContain('workflow-schema-evaluated');
      }
    });
  // The current-source entry-load lane measured 93 s for this graph. Allow the
  // child to finish linking/evaluation; this is a test deadline, not startup policy.
  }, 180_000);
});
