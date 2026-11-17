import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe('CLI Action dependencies', () => {
  it('does not load the external Session transport until an external Session Action uses it', async () => {
    const repo = resolve(import.meta.dirname, '../../../../..');
    const entry = resolve(import.meta.dirname, 'createCliActionDeps.ts');
    const sourceRuntime = resolve(repo, 'packages/cli-common/registerSourceRuntime.mjs');
    const script = `
      import { registerHooks } from 'node:module';
      import { pathToFileURL } from 'node:url';
      let loads = 0;
      registerHooks({ load(url, context, next) {
        if (url.includes('/externalSessions/hostExternalSessionActionTransport.')) loads++;
        return next(url, context);
      }});
      const { createCliActionDeps } = await import(pathToFileURL(${JSON.stringify(entry)}).href);
      const deps = createCliActionDeps({ token: 'fixture', credentials: { token: 'fixture', encryption: null },
        sessionId: '', serverId: 'home', serverHttpBaseUrl: 'https://home.test', mode: 'plain', ctx: null });
      const before = loads;
      const { EXTERNAL_SESSION_STATUS_GET_ACTION_ID } = await import(pathToFileURL(${JSON.stringify(resolve(repo, 'packages/protocol/src/actions/actionIds.ts'))}).href);
      const { API_TOKEN_FULL_GRANT_V1 } = await import(pathToFileURL(${JSON.stringify(resolve(repo, 'packages/protocol/src/auth/apiTokenGrant.ts'))}).href);
      const result = await deps.hostExternalSessionAction({ actionId: EXTERNAL_SESSION_STATUS_GET_ACTION_ID,
        input: { sessionId: 'fixture' }, context: { surface: 'cli', authority: 'present_user',
          externalActionCredential: { accountId: 'fixture', principalId: 'fixture', credentialId: 'fixture', grant: API_TOKEN_FULL_GRANT_V1 } } });
      console.log(JSON.stringify({ before, after: loads, errorCode: result.errorCode }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', sourceRuntime, '--input-type=module', '-e', script], {
      env: { ...process.env, TSX_TSCONFIG_PATH: resolve(repo, 'apps/cli/tsconfig.json') },
    });
    expect(JSON.parse(stdout.trim())).toEqual({ before: 0, after: 1, errorCode: 'not_authenticated' });
  }, 120_000);
});
