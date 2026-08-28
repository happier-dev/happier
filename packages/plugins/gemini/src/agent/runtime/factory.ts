import {
  type AgentRuntimeContext,
  type AgentRuntimeFactory,
  type AgentSessionOpenRequest,
  type AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { GEMINI_ACP_RUNTIME_DEFINITION } from '../acp/definition.js';
import {
  GEMINI_ACP_AUTH_META_ENV,
  GEMINI_ACP_AUTH_METHOD_ENV,
  resolveGeminiAcpFlag,
  resolveGeminiApiKeyFromEnv,
  resolveGeminiAuthConfig,
} from '../auth/resolution.js';
import { prepareGeminiNativeMcpShaping } from '../mcp/shaping.js';

function buildGeminiLaunchEnvironment(
  values: Readonly<Record<string, string>>,
  unset: readonly string[],
): Readonly<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...values };
  for (const key of unset) delete env[key];
  return env;
}

function ignoredGeminiAcpAuthControlEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const overlay: Record<string, string> = {};
  if (Object.prototype.hasOwnProperty.call(env, GEMINI_ACP_AUTH_METHOD_ENV)) overlay[GEMINI_ACP_AUTH_METHOD_ENV] = '';
  if (Object.prototype.hasOwnProperty.call(env, GEMINI_ACP_AUTH_META_ENV)) overlay[GEMINI_ACP_AUTH_META_ENV] = '';
  return overlay;
}

async function openGeminiSession(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
): Promise<AgentSessionRuntime> {
  const requestedLaunchEnvironment = request.launchEnvironment ?? { values: {}, unset: [] };
  const sourceEnv = buildGeminiLaunchEnvironment(
    requestedLaunchEnvironment.values,
    requestedLaunchEnvironment.unset,
  );
  const auth = resolveGeminiAuthConfig(sourceEnv, resolveGeminiApiKeyFromEnv(sourceEnv));
  const authControlEnv = ignoredGeminiAcpAuthControlEnv(sourceEnv);
  const shaping = await prepareGeminiNativeMcpShaping(sourceEnv);
  try {
    const flag = await resolveGeminiAcpFlag(context.services.exec, {
      env: {
        ...sourceEnv,
        ...shaping.env,
        ...authControlEnv,
        ...(auth.launchEnv ?? {}),
      },
      signal: context.signal,
    });
    const launchEnvironment = {
      values: {
        ...requestedLaunchEnvironment.values,
        ...authControlEnv,
        ...(auth.launchEnv ?? {}),
      },
      unset: requestedLaunchEnvironment.unset.filter(
        (key) => !Object.prototype.hasOwnProperty.call(authControlEnv, key)
          && !Object.prototype.hasOwnProperty.call(auth.launchEnv ?? {}, key),
      ),
    };
    const session = await context.protocols.acp.open({
      ...request,
      launchEnvironment,
    }, {
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'gemini-cli' },
        args: [flag],
        env: shaping.env,
        timeouts: {
          initializeMs: GEMINI_ACP_RUNTIME_DEFINITION.timeouts.initMs,
          idleMs: GEMINI_ACP_RUNTIME_DEFINITION.timeouts.idleMs,
          toolCallMs: GEMINI_ACP_RUNTIME_DEFINITION.timeouts.toolCallMs,
        },
      },
      definition: GEMINI_ACP_RUNTIME_DEFINITION,
    });
    let disposed = false;
    return {
      ...session,
      async dispose() {
        if (disposed) return;
        disposed = true;
        try {
          await session.dispose();
        } finally {
          await shaping.cleanup();
        }
      },
    };
  } catch (error) {
    await shaping.cleanup();
    throw error;
  }
}

export const createGeminiAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open: openGeminiSession,
  },
});
