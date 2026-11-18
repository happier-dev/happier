import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe('Action command loading', () => {
  it('does not load the Protocol root barrel while invoking inbox.get', async () => {
    const repo = resolve(import.meta.dirname, '../../../../..');
    const entry = resolve(import.meta.dirname, 'actions.ts');
    const script = `
      import { registerHooks } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const loaded = [];
      registerHooks({ load(url, context, next) {
        loaded.push(url);
        return next(url, context);
      }});
      const { handleActionsCommand } = await import(pathToFileURL(${JSON.stringify(entry)}).href);
      await handleActionsCommand(['invoke', 'inbox.get', '--input-json', '{}', '--json'], {
        // Credentials and saved profiles are device-storage boundaries. Keep the
        // real command and credentialed executor beneath those boundaries.
        readCredentialsFn: async () => ({ token: 'inbox-load-fixture', encryption: null }),
        getServerProfileFn: async () => { throw new Error('profile_not_stored'); },
      }, AbortSignal.abort());
      process.exitCode = 0;
      console.log(JSON.stringify({
        protocolRootLoads: loaded.filter(url => /\\/packages\\/protocol\\/(?:src|dist)\\/index\\.(?:ts|js)$/.test(url)).length,
        credentialExecutorLoads: loaded.filter(url => url.endsWith('/createCliActionExecutorFromCredentials.ts')).length,
      }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', resolve(repo, 'packages/cli-common/registerSourceRuntime.mjs'), '--input-type=module', '-e', script,
    ], { env: { ...process.env, TSX_TSCONFIG_PATH: resolve(repo, 'apps/cli/tsconfig.json') } });
    const lines = stdout.trim().split('\n');
    expect(JSON.parse(lines.slice(0, -1).join('\n'))).toMatchObject({
      ok: false, kind: 'actions_invoke', error: { code: 'cancelled' },
    });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      protocolRootLoads: 0, credentialExecutorLoads: 1,
    });
  }, 120_000);

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
