import type {
  PluginDisposable,
  PluginContextV1,
  RegisterBackendEngineV1,
} from '@happier-dev/plugin-sdk';
import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/acp';

import { GEMINI_ACP_BACKEND_SPEC } from './agent/acp/definition.js';
import {
  GEMINI_ACP_AUTH_META_ENV,
  GEMINI_ACP_AUTH_METHOD_ENV,
  GEMINI_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  resolveGeminiAcpFlag,
  resolveGeminiApiKeyFromEnv,
  resolveGeminiAuthConfig,
} from './agent/auth/resolution.js';
import { prepareGeminiMcpShaping } from './agent/mcp/shaping.js';

type PluginApiForGeminiV1 = Readonly<{
  registerBackendEngine: (registration: RegisterBackendEngineV1) => PluginDisposable | unknown;
  onDispose?: (disposable: PluginDisposable) => PluginDisposable;
}>;

type GeminiAcpCallbacksV1 = NonNullable<AcpBackendSpecV1['callbacks']>;
type GeminiAcpEnvBuilderParamsV1 = Parameters<NonNullable<GeminiAcpCallbacksV1['envBuilder']>>[0];
type GeminiAcpArgvBuilderParamsV1 = Parameters<NonNullable<GeminiAcpCallbacksV1['argvBuilder']>>[0];

const GEMINI_ACP_FLAGS = new Set(['--acp', '--experimental-acp']);

function selectGeminiAcpArgv(baseArgs: readonly string[], flag: string): readonly string[] {
  let replaced = false;
  const nextArgs = baseArgs.map((arg) => {
    if (!replaced && GEMINI_ACP_FLAGS.has(arg)) {
      replaced = true;
      return flag;
    }
    return arg;
  });
  return replaced ? nextArgs : [...baseArgs, flag];
}

export function activate(api: PluginApiForGeminiV1): void {
  const shapingCleanups = new Set<() => Promise<void> | void>();
  let disposed = false;

  async function cleanupGeminiMcpShaping(): Promise<void> {
    if (disposed) return;
    disposed = true;
    const pending = [...shapingCleanups].reverse();
    for (const cleanup of pending) {
      await cleanup();
    }
  }

  api.onDispose?.(cleanupGeminiMcpShaping);

  api.registerBackendEngine({
    backendId: 'gemini',
    create: async (ctx: PluginContextV1) => {
      const processEnv = ctx.env.list();
      const apiKey = resolveGeminiApiKeyFromEnv(processEnv);
      const auth = resolveGeminiAuthConfig(processEnv, apiKey);
      const authMeta = auth.authMeta;

      const spec = {
        ...GEMINI_ACP_BACKEND_SPEC,
        auth: {
          ...GEMINI_ACP_BACKEND_SPEC.auth,
          methodId: auth.authMethodId,
          ...(authMeta ? { buildAuthenticateMeta: () => authMeta } : {}),
          ...(auth.shouldInjectApiKeyEnv && apiKey
            ? {
              buildAuthEnv: () => ({
                [GEMINI_API_KEY_ENV]: apiKey,
                [GOOGLE_API_KEY_ENV]: apiKey,
              }),
            }
            : {}),
        },
        callbacks: {
          ...GEMINI_ACP_BACKEND_SPEC.callbacks,
          envBuilder: async (params: GeminiAcpEnvBuilderParamsV1) => {
            const {
              [GEMINI_ACP_AUTH_METHOD_ENV]: _authMethod,
              [GEMINI_ACP_AUTH_META_ENV]: _authMeta,
              ...childEnv
            } = params.env;
            const shaping = await prepareGeminiMcpShaping(ctx);
            if (disposed) {
              await shaping.cleanup();
              throw new Error('Gemini ACP MCP environment is disposed.');
            }

            const cleanup = async () => {
              if (!shapingCleanups.delete(cleanup)) return;
              await shaping.cleanup();
            };
            shapingCleanups.add(cleanup);
            ctx.abort.signal.addEventListener('abort', () => {
              void cleanup();
            }, { once: true });

            return {
              ...childEnv,
              ...shaping.env,
              GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
              GOOGLE_APPLICATION_CREDENTIALS: '',
            };
          },
          argvBuilder: async (params: GeminiAcpArgvBuilderParamsV1) => {
            if (disposed) {
              throw new Error('Gemini ACP argv builder is disposed.');
            }
            const flag = await resolveGeminiAcpFlag(ctx, {
              env: params.env,
              signal: ctx.abort.signal,
            });
            return selectGeminiAcpArgv(params.baseArgs, flag);
          },
        },
      } satisfies AcpBackendSpecV1;

      return ctx.acp.defineAcpBackend(spec);
    },
  });
}
