import type {
  AgentAcpRuntimeDefinition,
  AgentPermissionIntent,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { withCursorEmptyResponseFailure } from '../runtime/emptyResponse.js';
import { readCursorRuntimeSettings } from '../settings.js';
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
): readonly string[] {
  switch (permissionIntent) {
    case 'safe-yolo':
      return Object.freeze(['--force', '--sandbox', 'enabled']);
    case 'yolo':
      return Object.freeze(['--force']);
    default:
      return Object.freeze([]);
  }
}

function buildCursorAcpArgs(
  request: AgentSessionOpenRequest,
  apiEndpoint: string,
): readonly string[] {
  return Object.freeze([
    ...(apiEndpoint ? ['-e', apiEndpoint] : []),
    ...buildCursorPermissionIntentArgs(request.configuration?.permissionIntent.value ?? null),
    'acp',
  ]);
}

export async function openCursorAcpSession(
  request: AgentSessionOpenRequest,
  context: AgentSessionRuntimeContext,
): Promise<AgentSessionRuntime> {
  const settings = await readCursorRuntimeSettings(context.services.settings);
  const mediaSourceRoot = resolveCursorGeneratedMediaRoot({ directory: request.cwd });
  const runtime = await context.protocols.acp.open(request, {
    transport: Object.freeze({
      kind: 'stdio',
      executable: Object.freeze({
        kind: 'systemTool',
        id: settings.agentFallbackEnabled
          ? 'cursor-agent'
          : 'cursor-agent-no-fallback',
      }),
      ...(settings.binaryPath ? { preferredPath: settings.binaryPath } : {}),
      args: buildCursorAcpArgs(request, settings.apiEndpoint),
    }),
    definition: CURSOR_ACP_RUNTIME_DEFINITION,
    extensions: createCursorAcpRuntimeExtensions({
      context,
      ...(mediaSourceRoot ? { mediaSourceRoot } : {}),
    }),
  });
  return withCursorEmptyResponseFailure(runtime);
}
