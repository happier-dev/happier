import {
  toPluginHookObjectContext,
  toPluginHookPayloadEnvelope,
} from '@happier-dev/plugin-sdk';
import type {
  PluginApi,
  PluginApiHookRegistrationV1,
  PluginContextV1,
  PluginHookHandler,
} from '@happier-dev/plugin-sdk';
import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/experimental/acp';

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
import { resolveGeminiDaemonSpawnPrerequisites } from './agent/lifecycle/spawnHooks.js';
import { prepareGeminiMcpShaping } from './agent/mcp/shaping.js';

type GeminiAcpCallbacksV1 = NonNullable<AcpBackendSpecV1['callbacks']>;
type GeminiAcpAuthV1 = NonNullable<AcpBackendSpecV1['auth']>;
type GeminiAcpEnvBuilderParamsV1 = Parameters<NonNullable<GeminiAcpCallbacksV1['envBuilder']>>[0];
type GeminiAcpArgvBuilderParamsV1 = Parameters<NonNullable<GeminiAcpCallbacksV1['argvBuilder']>>[0];
type GeminiAcpResolveMethodIdParamsV1 = Parameters<NonNullable<GeminiAcpAuthV1['resolveMethodId']>>[1];
type GeminiSpawnPrerequisiteHookEvent = Parameters<typeof resolveGeminiDaemonSpawnPrerequisites>[0];
type GeminiSpawnPrerequisiteHookContext = NonNullable<Parameters<typeof resolveGeminiDaemonSpawnPrerequisites>[1]>;

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

function resolveGeminiAuthForEnv(env: Readonly<Record<string, string | undefined>>): Readonly<{
  apiKey: string | null;
  auth: ReturnType<typeof resolveGeminiAuthConfig>;
}> {
  const apiKey = resolveGeminiApiKeyFromEnv(env);
  return {
    apiKey,
    auth: resolveGeminiAuthConfig(env, apiKey),
  };
}

function tryResolveGeminiAuthForEnv(env: Readonly<Record<string, string | undefined>>): Readonly<{
  apiKey: string | null;
  auth: ReturnType<typeof resolveGeminiAuthConfig>;
}> | null {
  try {
    return resolveGeminiAuthForEnv(env);
  } catch {
    return null;
  }
}

function buildIgnoredGeminiAcpAuthControlEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const overlay: Record<string, string> = {};
  if (Object.prototype.hasOwnProperty.call(env, GEMINI_ACP_AUTH_METHOD_ENV)) {
    overlay[GEMINI_ACP_AUTH_METHOD_ENV] = '';
  }
  if (Object.prototype.hasOwnProperty.call(env, GEMINI_ACP_AUTH_META_ENV)) {
    overlay[GEMINI_ACP_AUTH_META_ENV] = '';
  }
  return overlay;
}

const resolveGeminiDaemonSpawnPrerequisitesHook: PluginHookHandler = (event, context) =>
  resolveGeminiDaemonSpawnPrerequisites(
    toPluginHookPayloadEnvelope<GeminiSpawnPrerequisiteHookEvent>(event),
    toPluginHookObjectContext<GeminiSpawnPrerequisiteHookContext>(context),
  );

export function activate(api: PluginApi): void {
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

  api.onDispose(cleanupGeminiMcpShaping);

  api.registerAgentRuntime({
    agentId: 'gemini',
    create: async (ctx: PluginContextV1) => {
      const spec = {
        ...GEMINI_ACP_BACKEND_SPEC,
        auth: {
          ...GEMINI_ACP_BACKEND_SPEC.auth,
          methodId: GEMINI_ACP_BACKEND_SPEC.auth?.methodId,
          resolveMethodId: (_ctx: PluginContextV1, params: GeminiAcpResolveMethodIdParamsV1) => {
            return resolveGeminiAuthForEnv(params.env).auth.authMethodId;
          },
        },
        callbacks: {
          ...GEMINI_ACP_BACKEND_SPEC.callbacks,
          envBuilder: async (params: GeminiAcpEnvBuilderParamsV1) => {
            const {
              [GEMINI_ACP_AUTH_METHOD_ENV]: _authMethod,
              [GEMINI_ACP_AUTH_META_ENV]: _authMeta,
              ...childEnv
            } = params.env;
            const finalAuth = resolveGeminiAuthForEnv(params.env).auth;
            const authControlEnv = buildIgnoredGeminiAcpAuthControlEnv(params.env);
            const authLaunchEnv = {
              ...authControlEnv,
              ...finalAuth.launchEnv,
            };
            if (!finalAuth.shouldUseIsolatedMcpHome) {
              return {
                ...childEnv,
                ...authLaunchEnv,
              };
            }
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
              ...authLaunchEnv,
            };
          },
          argvBuilder: async (params: GeminiAcpArgvBuilderParamsV1) => {
            if (disposed) {
              throw new Error('Gemini ACP argv builder is disposed.');
            }
            resolveGeminiAuthForEnv(params.env);
            const flag = await resolveGeminiAcpFlag(ctx, {
              env: params.env,
              signal: ctx.abort.signal,
            });
            return selectGeminiAcpArgv(params.baseArgs, flag);
          },
        },
      } satisfies AcpBackendSpecV1;

      return ctx.agentRuntime.acp.defineAcpBackend(spec);
    },
  });
  api.registerHook({
    hookId: 'agent.resolvePrerequisites',
    category: 'decision',
    scope: 'agent',
    filters: { agentId: 'gemini' },
    executionKind: 'decide',
    handler: resolveGeminiDaemonSpawnPrerequisitesHook,
  });
}
