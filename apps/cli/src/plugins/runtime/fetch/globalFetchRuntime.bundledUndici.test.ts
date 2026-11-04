import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { SOURCE_CONDITION, SOURCE_RUNTIME_OUTPUT_OPTIONS } from '../../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('plugin HTTP in the compiled runtime', () => {
  it('pairs bundled fetch and dispatcher for buffered and streamed requests despite an incompatible native fetch', async () => withTempDir('happier-plugin-http-bundle-', async outputDir => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('./globalFetchRuntime.ts', import.meta.url))],
      outdir: outputDir, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node20',
      ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
      conditions: [SOURCE_CONDITION], metafile: true, logLevel: 'silent',
      banner: { js: "import { createRequire as __artifactCreateRequire } from 'node:module'; import { fileURLToPath as __artifactFileURLToPath } from 'node:url'; import { dirname as __artifactDirname } from 'node:path'; const require = __artifactCreateRequire(import.meta.url); const __artifactFilename = __artifactFileURLToPath(import.meta.url); const __artifactDirectory = __artifactDirname(__artifactFilename);" },
      define: { __dirname: '__artifactDirectory', __filename: '__artifactFilename' },
    });
    expect(Object.keys(result.metafile.inputs).some(path => /node_modules\/undici\//.test(path))).toBe(true);
    const entryOutput = Object.entries(result.metafile.outputs).find(([, output]) => output.exports.includes('createGlobalFetchRuntime'));
    if (!entryOutput) throw new Error('Missing compiled plugin HTTP entry');
    await writeFile(join(outputDir, 'package.json'), '{"type":"module"}');
    const observed: string[] = [];
    const server = createServer((request, response) => {
      observed.push(request.url!);
      request.resume();
      request.on('end', () => {
        response.statusCode = request.url === '/refused' ? 429 : 200;
        response.end(request.url === '/refused' ? 'quota-refused' : 'quota-ready');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        const { createGlobalFetchRuntime } = await import(process.argv[1]);
        // Genuine platform boundary: reproduce Node's incompatible native Fetch/Agent ABI.
        globalThis.fetch = async () => {
          throw new TypeError('fetch failed', { cause: Object.assign(new Error('invalid onError method'), { code: 'UND_ERR_INVALID_ARG' }) });
        };
        const runtime = createGlobalFetchRuntime();
        const base = 'http://127.0.0.1:' + process.argv[2];
        const accepted = await runtime.request({ url: base + '/accepted' });
        const refused = await runtime.request({ url: base + '/refused' });
        const stream = await runtime.requestStream({ url: base + '/stream' });
        let streamed = '';
        try { for await (const chunk of stream.chunks) streamed += new TextDecoder().decode(chunk); }
        finally { await stream.dispose(); }
        const cancellation = new AbortController(); cancellation.abort();
        let cancelled;
        try { await runtime.request({ url: base + '/cancelled' }, { signal: cancellation.signal }); }
        catch (error) { cancelled = error.name; }
        console.log(JSON.stringify({ accepted: accepted.status, refused: refused.status,
          refusedBody: new TextDecoder().decode(refused.body), streamed, cancelled }));
      `, pathToFileURL(resolve(entryOutput[0])).href, String(address.port)], { encoding: 'utf8' });
      expect(JSON.parse(stdout)).toEqual({ accepted: 200, refused: 429, refusedBody: 'quota-refused', streamed: 'quota-ready', cancelled: 'AbortError' });
      expect(observed).toEqual(['/accepted', '/refused', '/stream']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  // The incumbent compiled-runtime test budget; this does not assert timing.
  }), 180_000);
});
