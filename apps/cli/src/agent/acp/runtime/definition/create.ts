import type {
  AcpRuntimeDefinitionInit,
  AcpRuntimeDefinition,
} from './_types';

export function createAcpRuntimeDefinition(
  init: AcpRuntimeDefinitionInit,
): AcpRuntimeDefinition {
  return Object.freeze({
    backendId: init.backendId,
    source: Object.freeze(init.source),
    identity: Object.freeze({
      ...(init.identity?.agentId ? { agentId: init.identity.agentId } : {}),
      backendId: init.identity?.backendId ?? init.backendId,
    }),
    engine: Object.freeze({
      kind: 'acp' as const,
    }),
    ux: Object.freeze(init.ux),
    transport: init.transport,
    launchEnv: Object.freeze({ ...(init.launchEnv ?? {}) }),
    capabilities: Object.freeze({ ...(init.capabilities ?? {}) }),
    ...(init.timeouts ? { timeouts: Object.freeze({ ...init.timeouts }) } : {}),
    ...(init.auth ? { auth: init.auth } : {}),
    ...(typeof init.fsEnabled === 'boolean' ? { fsEnabled: init.fsEnabled } : {}),
    ...(init.transportLifecycle ? { transportLifecycle: init.transportLifecycle } : {}),
    ...(init.permissionModeArgv ? { permissionModeArgv: init.permissionModeArgv } : {}),
    ...(init.sessionIdHeaderName ? { sessionIdHeaderName: init.sessionIdHeaderName } : {}),
    ...(init.toolNameInference ? { toolNameInference: Object.freeze({ ...init.toolNameInference }) } : {}),
    ...(init.stderrRules ? { stderrRules: Object.freeze({ ...init.stderrRules }) } : {}),
    ...(init.permissionOptionSelection ? { permissionOptionSelection: Object.freeze({ ...init.permissionOptionSelection }) } : {}),
    ...(init.messageMeta ? { messageMeta: init.messageMeta } : {}),
    mcp: Object.freeze(init.mcp ?? {
      policy: 'pass_through',
    }),
    callbacks: Object.freeze({ ...(init.callbacks ?? {}) }),
  });
}
