import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe('Action command loading', () => {
  it('does not load deployment CI, filesystem transfer or Session MCP clients for a generic Action', async () => {
    const repo = resolve(import.meta.dirname, '../../../../..');
    const entry = resolve(import.meta.dirname, 'actions.ts');
    const script = `
      import { registerHooks } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const names = ['deploymentCiStep.ts', 'accountArtifactStore.ts', 'readEnvironmentForHost.ts', 'createCredentialedFilesystemTransferClient.ts', 'sessionMcpLocalClient.ts'];
      const loaded = [];
      registerHooks({ load(url, context, next) {
        if (names.some(name => url.endsWith('/' + name))) loaded.push(url);
        return next(url, context);
      }});
      await import(pathToFileURL(${JSON.stringify(entry)}).href);
      console.log(JSON.stringify({ count: loaded.length }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', resolve(repo, 'packages/cli-common/registerSourceRuntime.mjs'), '--input-type=module', '-e', script,
    ], { env: { ...process.env, TSX_TSCONFIG_PATH: resolve(repo, 'apps/cli/tsconfig.json') } });
    expect(JSON.parse(stdout.trim())).toEqual({ count: 0 });
  }, 120_000);
});
