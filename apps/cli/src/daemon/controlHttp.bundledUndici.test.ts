import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { SOURCE_CONDITION, SOURCE_RUNTIME_COMMONJS_BANNER, SOURCE_RUNTIME_COMMONJS_DEFINE, SOURCE_RUNTIME_OUTPUT_OPTIONS } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('daemon control HTTP in the compiled runtime', () => {
  it('dials with bundled undici and preserves HTTP refusals and cancellation', async () => withTempDir('happier-control-bundle-', async (outputDir) => {
    // Match the source/guest bundle's split ESM, source condition and CJS require bridge.
    // Execute emitted exports in Node, outside Vitest's module transformer and mocks.
    const source = fileURLToPath(new URL('./controlHttp.ts', import.meta.url));
    const pluginHttpSource = fileURLToPath(new URL('../plugins/runtime/fetch/globalFetchRuntime.ts', import.meta.url));
    const result = await build({
      stdin: { contents: `export { readDaemonControlHttpResponse } from ${JSON.stringify(source)};
        export { createGlobalFetchRuntime } from ${JSON.stringify(pluginHttpSource)};`,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
      outdir: outputDir, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node20',
      ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
      conditions: [SOURCE_CONDITION], metafile: true, logLevel: 'silent',
      banner: { js: SOURCE_RUNTIME_COMMONJS_BANNER },
      define: SOURCE_RUNTIME_COMMONJS_DEFINE,
    });
    expect(Object.keys(result.metafile.inputs).some(path => /node_modules\/undici\//.test(path))).toBe(true);
    const entryOutput = Object.entries(result.metafile.outputs)
      .find(([, output]) => output.exports.includes('readDaemonControlHttpResponse')
        && output.exports.includes('createGlobalFetchRuntime'));
    expect(entryOutput).toBeDefined();
    await writeFile(join(outputDir, 'package.json'), '{"type":"module"}');
    const observed: Array<{ path: string | undefined; method: string | undefined; body: string }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        observed.push({ path: request.url, method: request.method, body });
        response.statusCode = request.url === '/refused' ? 409 : 200;
        response.setHeader('content-type', 'application/json');
        response.end(request.url === '/refused' ? '{"errorCode":"approval_required"}' : '{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing server address');
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        try {
        const { readDaemonControlHttpResponse: read, createGlobalFetchRuntime } = await import(process.argv[1]);
        // Model the guest's native fetch/package-dispatcher ABI mismatch at the
        // platform boundary. The control transport must use its dispatcher's fetch.
        const nativeFetch = globalThis.fetch;
        globalThis.fetch = async () => {
          throw new TypeError('fetch failed', { cause: Object.assign(new Error('invalid onError method'), { code: 'UND_ERR_INVALID_ARG' }) });
        };
        const input = { httpPort: Number(process.argv[2]), body: { hello: 'bundle' }, headers: {} };
        const accepted = await read({ ...input, path: '/ping' });
        const refused = await read({ ...input, path: '/refused' });
        const cancellation = new AbortController();
        cancellation.abort();
        let cancelled;
        try { await read({ ...input, path: '/cancelled', signal: cancellation.signal }); }
        catch (error) { cancelled = error.name; }
        globalThis.fetch = nativeFetch;
        const pluginHttp = createGlobalFetchRuntime();
        const pluginResponse = await pluginHttp.request({
          url: 'http://127.0.0.1:' + input.httpPort + '/plugin', method: 'POST', redirect: 'error',
          body: new TextEncoder().encode('plugin-body'),
        });
        let pluginCancelled;
        try { await pluginHttp.request({ url: 'http://127.0.0.1:' + input.httpPort + '/not-dispatched' }, { signal: cancellation.signal }); }
        catch (error) { pluginCancelled = error.name; }
        console.log(JSON.stringify({ accepted, refused, cancelled,
          plugin: { status: pluginResponse.status, body: new TextDecoder().decode(pluginResponse.body), cancelled: pluginCancelled } }));
        } catch (error) {
          console.error(error);
          process.exitCode = 1;
        }
      `, pathToFileURL(resolve(entryOutput![0])).href, String(address.port)], { encoding: 'utf8' });
      expect(JSON.parse(stdout)).toEqual({
        accepted: { ok: true, status: 200, body: '{"ok":true}' },
        refused: { ok: false, status: 409, body: '{"errorCode":"approval_required"}' },
        cancelled: 'AbortError',
        plugin: { status: 200, body: '{"ok":true}', cancelled: 'AbortError' },
      });
      expect(observed).toEqual([
        ...['/ping', '/refused'].map(path => ({ path, method: 'POST', body: '{"hello":"bundle"}' })),
        { path: '/plugin', method: 'POST', body: 'plugin-body' },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  // Same compilation budget as startup/idleGraph.integration.test.ts, not a timing assertion.
  }), 180_000);
});
