import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution.ts';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '../../protocol/src/actions/externalActionApi.ts';

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function browserSourcesPlugin() {
  const manifest = JSON.parse(readFileSync(resolve(sdkDir, 'package.json'), 'utf8'));
  const target = manifest.imports['#http'].default;
  assert.match(target, /^\.\/dist\/.*\.js$/u);
  const httpSource = resolve(sdkDir, target.replace('./dist/', './src/').replace(/\.js$/u, '.ts'));
  const workspaces = ['protocol', 'agents', 'session-core', 'sync-client', 'connection-supervisor'].map((name) => ({
    packageName: `@happier-dev/${name}`, packageSourceRoot: resolve(sdkDir, '..', name, 'src'),
  }));
  const sources = createWorkspacePackageSourcesPlugin(workspaces, 'sdk-browser-source-resolution', { exportConditions: ['browser'] });
  return {
    name: 'sdk-browser-source-resolution',
    setup(build) {
      build.onResolve({ filter: /^#http$/ }, () => ({ path: httpSource }));
      build.onResolve({ filter: /^(?:@happier-dev\/|\.\.?\/)/ }, ({ path, importer }) => {
        const resolved = sources.resolveId(path, importer);
        return resolved ? { path: resolved } : undefined;
      });
    },
  };
}

export async function validateBrowserConsumer() {
  const bundle = await build({
    entryPoints: [resolve(sdkDir, 'src/index.public.ts')],
    absWorkingDir: sdkDir,
    bundle: true, platform: 'browser', format: 'iife', globalName: 'HappierSdk',
    write: false, metafile: true,
    plugins: [browserSourcesPlugin()],
  });
  const inputs = Object.keys(bundle.metafile.inputs);
  assert.ok(inputs.every((path) => !/(?:^|\/)undici(?:\/|$)/u.test(path)), 'Browser bundle includes undici.');
  assert.ok(Object.values(bundle.metafile.outputs).every((output) => output.imports.every(({ path }) => !path.startsWith('node:'))), 'Browser bundle imports Node builtins.');
  const requests = [];
  let requestHandler;
  let responseBody = () => new Response(JSON.stringify({
    v: 1, actionId: 'machines.list', execution: { ok: true, result: [] },
  }), { headers: { 'content-type': 'application/json' } });
  const context = {
    URL, AbortController, AbortSignal, TextEncoder, TextDecoder, Uint8Array,
    setTimeout, clearTimeout, atob, btoa, crypto: webcrypto,
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return requestHandler ? requestHandler(url, options) : responseBody();
    },
  };
  runInNewContext(bundle.outputFiles[0].text, context);
  const client = context.HappierSdk.connect({ endpoint: 'https://api.example.test/', token });
  try {
    assert.deepEqual(Array.from(await client.actions.execute('machines.list', {})), []);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.example.test/v1/actions/machines.list');
    assert.equal(requests[0].options.headers.authorization, `Bearer ${token}`);
    let cancelled = false;
    responseBody = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-length': String(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES + 1) } });
    await assert.rejects(client.actions.execute('machines.list', {}), { code: 'response_too_large' });
    assert.equal(cancelled, true, 'An oversized declared browser response must cancel its stream.');
    cancelled = false;
    responseBody = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES + 1)); },
      cancel() { cancelled = true; },
    }));
    await assert.rejects(client.actions.execute('machines.list', {}), { code: 'response_too_large' });
    assert.equal(cancelled, true, 'An oversized streamed browser response must cancel its stream.');
    responseBody = () => new Response(JSON.stringify({
      v: 1, actionId: 'machines.list', execution: { ok: true, result: [] },
    }).padEnd(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, ' '));
    assert.deepEqual(Array.from(await client.actions.execute('machines.list', {})), []);
    const abort = new AbortController();
    const reason = new Error('caller cancelled');
    requestHandler = (_url, options) => new Promise((_resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const cancelledRequest = client.actions.execute('machines.list', {}, { signal: abort.signal });
    abort.abort(reason);
    await assert.rejects(cancelledRequest, (error) => error === reason);
    const closingRequest = client.actions.execute('machines.list', {});
    const closed = assert.rejects(closingRequest, { name: 'HappierClientClosedError' });
    await client.close();
    await closed;
  } finally {
    await client.close();
  }
  let cleanupAborted = false;
  requestHandler = (url, options) => {
    const actionId = new URL(url).pathname.split('/').at(-1);
    if (actionId === 'session.status.get') return new Response(JSON.stringify({
      v: 1, actionId, execution: { ok: true, result: { session: { active: false } } },
    }));
    if (actionId === 'transcript.follow') return new Response(JSON.stringify({
      v: 1, actionId, execution: { ok: true, result: {
        items: [{ role: 'assistant' }], nextCursor: '1', truncated: false,
      } },
    }));
    assert.equal(actionId, 'transcript.unfollow');
    return new Promise((_resolve, reject) => {
      const aborted = () => { cleanupAborted = true; reject(options.signal.reason); };
      if (options.signal.aborted) aborted();
      else options.signal.addEventListener('abort', aborted, { once: true });
    });
  };
  const cleanupClient = context.HappierSdk.connect({ endpoint: 'https://api.example.test/', token });
  try {
    const iterator = cleanupClient.sessions.get('session-1').followTranscript()[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.role, 'assistant');
    await cleanupClient.close();
    assert.equal(cleanupAborted, true, 'Client close must terminate a hanging browser cleanup request after its grace.');
  } finally {
    await cleanupClient.close();
  }
  return { bytes: bundle.outputFiles[0].contents.byteLength, inputs: inputs.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await validateBrowserConsumer()));
}
