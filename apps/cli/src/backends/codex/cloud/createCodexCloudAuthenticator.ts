import type { CloudConnectAuthenticateOptions } from '@/cloud/connectTypes';

import type { CodexAuthTokens } from './authenticate';

export type CodexCloudAuthMode = 'device' | 'paste' | 'loopback';

export function resolveCodexCloudAuthMode(opts?: CloudConnectAuthenticateOptions): CodexCloudAuthMode {
  if (opts?.paste && opts?.device) {
    throw new Error('Cannot combine --paste and --device for Codex authentication.');
  }
  if (opts?.device) return 'device';
  if (opts?.paste) return 'paste';
  return 'loopback';
}

export type CodexCloudAuthenticatorDeps = Readonly<{
  now: () => number;
  authenticateDevice: (params: { now: number; opts?: CloudConnectAuthenticateOptions }) => Promise<CodexAuthTokens>;
  authenticatePkce: (params: {
    mode: Exclude<CodexCloudAuthMode, 'device'>;
    opts?: CloudConnectAuthenticateOptions;
  }) => Promise<CodexAuthTokens>;
}>;

export function createCodexCloudAuthenticator(deps: CodexCloudAuthenticatorDeps) {
  return async (opts?: CloudConnectAuthenticateOptions): Promise<CodexAuthTokens> => {
    const mode = resolveCodexCloudAuthMode(opts);

    if (mode === 'device') {
      return await deps.authenticateDevice({ now: deps.now(), opts });
    }

    return await deps.authenticatePkce({
      mode,
      opts,
    });
  };
}
