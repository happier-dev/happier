import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFailed, onTestFinished } from 'vitest';

import { projectPath } from '@/projectPath';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess } from '@/testkit/process/spawn';
import { resolveCliTsxTsconfigPath } from '@/utils/spawnHappyCLI';

describe('daemon transport first use', () => {
  it.each(['control', 'remote', 'managed'] as const)('loads external Undici only for the first real %s HTTP operation', async kind => {
    const cliRoot = projectPath();
    const repoRoot = join(cliRoot, '..', '..');
    const sourceUrl = (path: string) => pathToFileURL(join(cliRoot, 'src', path)).href;
    await withTempDir('happier-transport-demand-', async tempDir => {
      const probe = join(tempDir, 'transport-demand.mjs');
      await writeFile(probe, [
        'import assert from "node:assert/strict";',
        'import { createRequire } from "node:module";',
        'import { createServer } from "node:http";',
        `const require = createRequire(${JSON.stringify(pathToFileURL(join(cliRoot, 'package.json')).href)});`,
        // Observe the actual CommonJS package cache, not a replacement loader
        // or Node's separate built-in fetch implementation.
        'const externalUndici = () => Object.keys(require.cache).filter(path => path.replaceAll("\\\\", "/").includes("/node_modules/undici/"));',
        'assert.deepEqual(externalUndici(), [], "probe must begin without external Undici");',
        'const originalFetch = globalThis.fetch;',
        'const server = createServer((request, response) => { request.resume(); response.end("transport-ready"); });',
        'await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));',
        'const port = server.address().port;',
        'const baseUrl = "http://127.0.0.1:" + port;',
        'let dispose = async () => {};',
        'try {',
        ...(kind === 'control' ? [
          `  const owner = await import(${JSON.stringify(sourceUrl('daemon/controlHttp.ts'))});`,
          '  assert.deepEqual(externalUndici(), [], "control module import must stay cold");',
          '  const cancelled = new AbortController(); cancelled.abort(new Error("already retired"));',
          '  await assert.rejects(owner.readDaemonControlHttpResponse({ httpPort: port, path: "/cancelled", body: {}, headers: {}, signal: cancelled.signal }), /already retired/);',
          '  assert.deepEqual(externalUndici(), [], "pre-cancelled control work must stay cold");',
          '  const response = await owner.readDaemonControlHttpResponse({ httpPort: port, path: "/control", body: {}, headers: {} });',
          '  assert.equal(response.status, 200); assert.equal(response.body, "transport-ready");',
        ] : kind === 'remote' ? [
          `  const owner = await import(${JSON.stringify(sourceUrl('plugins/discovery/remote/acquisition.ts'))});`,
          '  assert.deepEqual(externalUndici(), [], "remote module import must stay cold");',
          '  const custom = await owner.openRemoteAcquisition({ url: baseUrl + "/custom", headers: {}, fetchImpl: globalThis.fetch,',
          '    policy: { scheme: "httpOrHttps", redirects: "anyAssessedOrigin", privateNetwork: "followCallerDestination" }, errorLabel: "custom transport probe" });',
          '  assert.equal(await custom.response.text(), "transport-ready"); await custom.dispose();',
          '  assert.deepEqual(externalUndici(), [], "a caller-owned remote transport must not load external Undici");',
          '  const opened = await owner.openRemoteAcquisition({ url: baseUrl + "/archive", headers: {},',
          '    policy: { scheme: "httpOrHttps", redirects: "anyAssessedOrigin", privateNetwork: "followCallerDestination" }, errorLabel: "transport probe" });',
          '  dispose = opened.dispose;',
          '  assert.equal(await opened.response.text(), "transport-ready");',
        ] : [
          `  const { createManagedServicesOwner } = await import(${JSON.stringify(sourceUrl('plugins/runtime/invocation/services/managedServicesOwner.ts'))});`,
          `  const { createManagedServiceProcessSupervisorHost } = await import(${JSON.stringify(sourceUrl('plugins/runtime/invocation/services/managedProcessSupervisor.ts'))});`,
          `  const { createUnavailableManagedServices } = await import(${JSON.stringify(sourceUrl('plugins/runtime/invocation/services/managedServicesAdapter.ts'))});`,
          `  const { createUnavailablePluginServices } = await import(${JSON.stringify(sourceUrl('plugins/runtime/invocation/services/unavailable.ts'))});`,
          '  assert.deepEqual(externalUndici(), [], "managed module import must stay cold");',
          '  const owner = createManagedServicesOwner({ processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: "daemon" }),',
          '    dependencies: createUnavailableManagedServices().dependencies, resolveScope: seed => seed });',
          '  dispose = () => owner.dispose();',
          '  const lifetime = new AbortController();',
          '  const isCurrent = () => !lifetime.signal.aborted;',
          '  const services = owner.bindScope({ occurrenceId: "transport-probe", pluginId: "acme.transport",',
          '    contributionQualifiedId: "acme.transport/providers/gateway", operationId: "transport-probe", signal: lifetime.signal, isOccurrenceCurrent: isCurrent },',
          '    createUnavailablePluginServices().exec, { managedProvider: { realm: "managedProviderStart", providerLocalId: "gateway", isCurrent } });',
          '  assert.deepEqual(externalUndici(), [], "creating and binding a managed owner must stay cold");',
          '  const handle = await services.supervise({ id: "gateway", mode: { kind: "attach", baseUrl }, clientAccess: { kind: "none" },',
          '    healthCheck: { kind: "http", target: { kind: "servicePath", path: "/health" } } });',
          '  await handle.waitUntilHealthy();',
          '  const responses = await Promise.all([handle.request({ pathAndQuery: "/first", method: "GET" }), handle.request({ pathAndQuery: "/concurrent", method: "GET" })]);',
          '  for (const response of responses) { assert.equal(response.status, 200); assert.equal(await new Response(response.body).text(), "transport-ready"); }',
        ]),
        '  assert.ok(externalUndici().length > 0, "first real operation must load the actual external transport");',
        '  assert.strictEqual(globalThis.fetch, originalFetch, "global Node fetch must not be replaced");',
        `  process.stdout.write(JSON.stringify({ kind: ${JSON.stringify(kind)}, externalUndiciModules: externalUndici().length }) + "\\n");`,
        '  process.stdout.write("transport-demand-verified\\n");',
        '} finally { await dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }',
      ].join('\n'), 'utf8');
      const child = spawnTestProcess(process.execPath, ['--import', pathToFileURL(join(repoRoot, 'packages', 'cli-common', 'registerSourceRuntime.mjs')).href, probe], {
        cwd: cliRoot, env: { ...process.env, TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath() }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const closed = once(child, 'close');
      const diagnostics: string[] = [];
      child.stdout?.on('data', chunk => diagnostics.push(String(chunk)));
      child.stderr?.on('data', chunk => diagnostics.push(String(chunk)));
      onTestFailed(() => console.error(diagnostics.join('')));
      onTestFinished(async () => {
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
      });
      const [code] = await closed;
      expect(code, diagnostics.join('')).toBe(0);
      expect(diagnostics.join('')).toContain('transport-demand-verified');
      for (const line of diagnostics.join('').split('\n').filter(line => line.startsWith('{"kind":'))) console.info(line);
    });
  });
});
