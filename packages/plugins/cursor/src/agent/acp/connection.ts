import type {
  AgentAcpRuntimeDefinition,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeContextV1,
  AgentPermissionIntent,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentSessionSkillDelivery,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { withCursorEmptyResponseFailure } from '../runtime/emptyResponse.js';
import { buildCursorEndpointArgs, readCursorRuntimeSettings } from '../settings.js';
import { createCursorAcpRuntimeExtensions } from './extensions/index.js';
import { resolveCursorGeneratedMediaRoot } from './mediaRoot.js';
import { resolveCursorAcpToolName, sanitizeCursorDiffContent } from './transport.js';

export const CURSOR_ACP_RUNTIME_DEFINITION = Object.freeze({
  auth: Object.freeze({ methodId: 'cursor_login' }),
  parameterizedModelPicker: true,
  modelConfigOptionId: 'model',
  toolNameResolver: resolveCursorAcpToolName,
  sanitizeToolUpdateContent: sanitizeCursorDiffContent,
  mcp: Object.freeze({ policy: 'pass_through' }),
} satisfies AgentAcpRuntimeDefinition);

function buildCursorPermissionIntentArgs(
  permissionIntent: AgentPermissionIntent | null,
  nativeSandbox?: 'on' | 'off',
): readonly string[] {
  const sandboxArgs = nativeSandbox === undefined ? [] : ['--sandbox', nativeSandbox === 'on' ? 'enabled' : 'disabled'];
  switch (permissionIntent) {
    case 'safe-yolo':
      return Object.freeze(['--force', ...(nativeSandbox === undefined ? ['--sandbox', 'enabled'] : sandboxArgs)]);
    case 'yolo':
      return Object.freeze(['--force', ...sandboxArgs]);
    default:
      return Object.freeze(sandboxArgs);
  }
}

export function buildCursorAcpArgs(
  permissionIntent: AgentPermissionIntent | null,
  apiEndpoint: string,
  skills?: Pick<AgentSessionSkillDelivery, 'pluginRoot'>,
  nativeSandbox?: 'on' | 'off',
): readonly string[] {
  return Object.freeze([
    ...buildCursorEndpointArgs(apiEndpoint),
    ...buildCursorPermissionIntentArgs(permissionIntent, nativeSandbox),
    ...(skills ? ['--plugin-dir', skills.pluginRoot] : []),
    'acp',
  ]);
}

async function resolveCursorAcpOptions(
  request: Pick<AgentSessionOpenRequest, 'configuration' | 'skills'>,
  context: Pick<AgentSessionRuntimeContext, 'services'>,
) {
  const settings = await readCursorRuntimeSettings(context.services.settings);
  return {
    settings,
    options: {
      transport: Object.freeze({
        kind: 'stdio' as const,
        executable: Object.freeze({
          kind: 'systemTool' as const,
          id: settings.agentFallbackEnabled
            ? 'cursor-agent'
            : 'cursor-agent-no-fallback',
        }),
        ...(settings.binaryPath ? { preferredPath: settings.binaryPath } : {}),
        args: buildCursorAcpArgs(request.configuration?.permissionIntent.value ?? null, settings.apiEndpoint, request.skills,
          request.configuration?.nativeSandbox),
      }),
      definition: CURSOR_ACP_RUNTIME_DEFINITION,
    },
  };
}

export async function openCursorAcpSession(
  request: AgentSessionOpenRequest,
  context: AgentSessionRuntimeContext,
): Promise<AgentSessionRuntime> {
  const { options } = await resolveCursorAcpOptions(request, context);
  const mediaSourceRoot = resolveCursorGeneratedMediaRoot({ directory: request.cwd, env: request.launchEnvironment?.values ?? {} });
  const runtime = await context.protocols.acp.open(request, {
    ...options,
    extensions: createCursorAcpRuntimeExtensions({
      context,
      ...(mediaSourceRoot ? { mediaSourceRoot } : {}),
    }),
  });
  return withCursorEmptyResponseFailure(runtime);
}

export async function openCursorAcpExecutionRun(
  request: AgentExecutionRunOpenRequest,
  context: AgentExecutionRunRuntimeContextV1,
): Promise<AgentExecutionRunRuntime> {
  const { options } = await resolveCursorAcpOptions(request, context);
  return await context.protocols.acp.openExecutionRunV1(request, options);
}
