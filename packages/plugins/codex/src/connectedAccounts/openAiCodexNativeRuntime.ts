import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { CodexNativeImportError, readCodexNativeAuthCredentials } from '../agent/cli/auth/nativeImport.js';
import {
  codexConnectedAccountResult,
  openAiCodexConnectedAccountRuntime as portableRuntime,
  writeCodexConnectedAccountTokens,
} from './openAiCodexRuntime.js';

/** Native credential import is available only in the daemon entry graph. */
export const openAiCodexConnectedAccountRuntime: ConnectedAccountRuntime = {
  ...portableRuntime,
  authentication: {
    modes: {
      ...portableRuntime.authentication.modes,
      'native-import': {
        kind: 'manual',
        async complete(input, context, options) {
          if (input.fields.source !== 'native') {
            return { status: 'rejected', diagnostic: {
              code: 'openai_codex_import_source_unsupported', severity: 'error',
              message: 'The Codex import source is unsupported.',
            } };
          }
          const signal = options?.signal ?? context.signal;
          let native: Awaited<ReturnType<typeof readCodexNativeAuthCredentials>>;
          try {
            native = await readCodexNativeAuthCredentials({ signal });
          } catch (error) {
            if (signal.aborted) throw new DOMException('Credential import cancelled', 'AbortError');
            if (error instanceof CodexNativeImportError && error.code === 'reauthorization_required') {
              return { status: 'rejected', diagnostic: {
                code: 'openai_codex_import_reauthorization_required', severity: 'error',
                message: 'Sign in to Codex again before importing.',
              } };
            }
            return { status: 'unavailable', diagnostic: {
              code: 'openai_codex_import_credentials_unavailable', severity: 'error',
              message: 'Codex native credentials are unavailable.',
            } };
          }
          const tokens = {
            accessToken: native.accessToken, refreshToken: native.refreshToken, idToken: native.idToken,
            providerAccountId: native.accountId, expiresAtMs: native.expiresAt,
          };
          await writeCodexConnectedAccountTokens(context.attemptCredentials, tokens, { signal });
          return codexConnectedAccountResult(tokens);
        },
      },
    },
  },
};
