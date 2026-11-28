import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { repoRootDir } from './paths';

const run = promisify(execFile);

it.each(['in-process', 'daemon preload'] as const)('records provider HTTPS after Undici loads first (%s)', async mode => {
  const boundary = mode === 'daemon preload'
    ? await (await import('./deploymentProvidersHttp')).startDeploymentProvidersHttp({ seedManagedProjects: true })
    : undefined;
  // Use Node's native ESM/CJS interop, as the real daemon does. The rejecting
  // direct connector makes an escaped request fail without reaching a provider.
  const code = `
    import assert from 'node:assert/strict';
    const { loadUndici } = await import('./apps/cli/src/utils/loadUndici.ts');
    const { Agent, fetch } = await loadUndici();
    const direct = new Agent({ connect(_options, callback) {
      callback(new Error('direct provider connection blocked'), null);
    } });
    let boundary;
    try {
      if (process.argv[1] === 'daemon preload') {
        await import('./packages/tests/src/testkit/deploymentProvidersHttpPreload.mjs');
      } else {
        const { startDeploymentProvidersHttp } = await import('./packages/tests/src/testkit/deploymentProvidersHttp.ts');
        boundary = await startDeploymentProvidersHttp({ seedManagedProjects: true });
      }
      for (const url of [
        'https://console.neon.tech/api/v2/organizations/org-journey',
        'https://api.supabase.com/v1/organizations',
      ]) {
        const response = await fetch(url, { dispatcher: direct });
        try { assert.equal(response.status, 200); }
        finally { await response.body?.cancel(); }
      }
      if (boundary) assert.equal(boundary.entries().length, 2);
    } finally {
      try { await direct.destroy(); }
      finally { await boundary?.stop(); }
    }
  `;
  const root = repoRootDir();
  const loader = pathToFileURL(resolve(root, 'packages/cli-common/registerSourceRuntime.mjs')).href;
  try {
    await run(process.execPath, [
      '--conditions=happier-source', '--import', loader, '--input-type=module', '--eval', code, mode,
    ], { cwd: root, env: { ...process.env, ...boundary?.env } });
    if (boundary) expect(boundary.entries()).toHaveLength(2);
  } finally {
    await boundary?.stop();
  }
});
