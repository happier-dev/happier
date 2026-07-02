import type {
  CodexAuthTokens,
  CodexCloudAuthenticateOptions,
} from './types.js';

export type CodexCloudAuthMode = 'device' | 'paste' | 'loopback';

export function resolveCodexCloudAuthMode(opts?: CodexCloudAuthenticateOptions): CodexCloudAuthMode {
  if (opts?.paste && opts?.device) {
    throw new Error('Cannot combine --paste and --device for Codex authentication.');
  }
  if (opts?.device) return 'device';
  if (opts?.paste) return 'paste';
  return 'loopback';
}

export type CodexCloudAuthenticatorDeps = Readonly<{
  now: () => number;
  authenticateDevice: (params: { now: number; opts?: CodexCloudAuthenticateOptions }) => Promise<CodexAuthTokens>;
  authenticatePkce: (params: {
    mode: Exclude<CodexCloudAuthMode, 'device'>;
    opts?: CodexCloudAuthenticateOptions;
  }) => Promise<CodexAuthTokens>;
}>;

export function createCodexCloudAuthenticator(deps: CodexCloudAuthenticatorDeps) {
  return async (opts?: CodexCloudAuthenticateOptions): Promise<CodexAuthTokens> => {
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
