import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createSecureTempDirectorySync } from '@happier-dev/plugin-sdk/fs';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { readCodeRabbitAuthStatus } from './agent/authStatus.js';
import { CODERABBIT_SYSTEM_TOOL_ID } from './agent/reviews/systemTool.js';
import { CODERABBIT_AUTH_FILE } from './connectedAccountDeclarations.js';

/** CLI 0.9.6 respects HOME for auth.json. Never inherit a competing Machine key. */
export function codeRabbitHomeEnvironment(home: string): Readonly<Record<string, string>> {
  return { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), CODERABBIT_API_KEY: '' };
}

const unavailable = () => ({ status: 'unavailable' as const, diagnostic: {
  code: 'coderabbit_login_required', severity: 'error' as const,
  message: 'Complete CodeRabbit browser sign-in on this Machine, then reconnect the account.',
} });

/** The vendor owns its localhost callback and opaque auth file; the host owns custody. */
export const CODERABBIT_ACCOUNT_RUNTIME: ConnectedAccountRuntime = {
  authentication: { modes: {
    'native-login': { kind: 'manual', async complete(input, context, options) {
      const signal = options?.signal ?? context.signal;
      signal.throwIfAborted();
      const region = input.fields.region;
      if (region !== 'us' && region !== 'eu') return unavailable();
      const directory = createSecureTempDirectorySync({ prefix: 'coderabbit-login' });
      try {
        const env = codeRabbitHomeEnvironment(directory.path);
        const login = await context.services.exec.run({ executable: { kind: 'systemTool', id: CODERABBIT_SYSTEM_TOOL_ID },
          args: ['auth', 'login', '--agent', '--region', region], cwd: directory.path, env }, { signal });
        signal.throwIfAborted();
        if (login.termination.observed.kind === 'failed') return { status: 'unavailable', diagnostic: login.termination.observed.diagnostic };
        if (login.termination.observed.kind !== 'exit' || login.termination.observed.exitCode !== 0) return unavailable();
        const status = await context.services.exec.run({ executable: { kind: 'systemTool', id: CODERABBIT_SYSTEM_TOOL_ID },
          args: ['auth', 'status', '--agent'], cwd: directory.path, env }, { signal });
        signal.throwIfAborted();
        if (status.termination.observed.kind === 'failed') return { status: 'unavailable', diagnostic: status.termination.observed.diagnostic };
        if (status.termination.observed.kind !== 'exit' || status.termination.observed.exitCode !== 0
          || readCodeRabbitAuthStatus(new TextDecoder().decode(status.stdout)).state !== 'logged_in') return unavailable();
        // No guessed vendor schema: import precisely the file the verified native login wrote.
        let auth: Buffer;
        try { auth = await readFile(join(directory.path, CODERABBIT_AUTH_FILE), { signal }); }
        catch { signal.throwIfAborted(); return unavailable(); }
        if (!auth.length) return unavailable();
        await context.attemptCredentials.set('nativeAuth', auth.toString('base64'), { signal });
        return { status: 'connected', credentialKind: 'oauth', displayName: 'CodeRabbit', scopes: [] };
      } finally { directory.cleanup(); }
    } },
  } },
  async status(context, options) {
    return await context.credentials.get('nativeAuth', options)
      ? { status: 'connected', displayName: 'CodeRabbit', credentialKind: 'oauth' } : unavailable();
  },
  async refresh() { return { status: 'reconnectRequired' }; },
  async revoke() { return { status: 'remoteUnsupported' }; },
  async materialize(request, context, options) {
    if (request.kind !== 'files') throw new PluginError({ code: 'plugin_connected_account_materialization_unsupported',
      message: 'CodeRabbit supports its native authentication file only.' });
    const auth = await context.credentials.get('nativeAuth', options);
    if (!auth) throw new PluginError({ code: 'plugin_connected_account_credentials_unavailable',
      message: 'Reconnect the selected CodeRabbit account.' });
    const files: Record<string, Uint8Array> = {};
    if (request.fileIds.includes(CODERABBIT_AUTH_FILE)) {
      files[CODERABBIT_AUTH_FILE] = options?.existingFiles?.[CODERABBIT_AUTH_FILE] ?? Buffer.from(auth, 'base64');
    }
    return { kind: 'files', files };
  },
};
