import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

it('imports the shared core in a browser bundle without native or Node dependencies', async () => {
  const sources = createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/protocol', packageSourceRoot: fileURLToPath(new URL('../../protocol/src', import.meta.url)) },
    { packageName: '@happier-dev/agents', packageSourceRoot: fileURLToPath(new URL('../../agents/src', import.meta.url)) },
  ]);
  const result = await build({ entryPoints: [new URL('./index.ts', import.meta.url).pathname],
    bundle: true, platform: 'browser', format: 'iife', globalName: 'SessionCore', write: false,
    plugins: [{ name: 'workspace-sources', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
        const resolved = sources.resolveId(path, importer);
        return resolved ? { path: resolved } : undefined;
      });
    } }],
  });
  // The VM does not install browser globals; use their real implementations.
  const scope: Record<string, unknown> = { TextEncoder, TextDecoder, URL, URLSearchParams, structuredClone };
  // Protocol clones JSON schemas. The host clone returns host-realm objects;
  // rehydrate that JSON in the receiving realm, as a browser-local clone would.
  runInNewContext(`
    const cloneFromHost = structuredClone;
    globalThis.structuredClone = value => JSON.parse(JSON.stringify(cloneFromHost(value)));
  `, scope);
  runInNewContext(result.outputFiles[0].text, scope);
  const text = runInNewContext(`
    const normalized = SessionCore.normalizeRawMessage('browser-row', null, 1, {
      role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'text', text: 'browser-safe' } },
    });
    SessionCore.reducer(SessionCore.createReducer(), [normalized]).messages[0].text;
  `, scope);
  expect(text).toBe('browser-safe');
});
