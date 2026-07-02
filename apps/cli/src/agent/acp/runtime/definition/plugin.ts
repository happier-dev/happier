import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk';

import type {
  AcpRuntimeDefinitionInitV1,
  AcpRuntimeDefinitionV1,
} from './_types';
import { createAcpRuntimeDefinition } from './runtimeCore';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      return undefined;
    }
    out[key] = entry;
  }
  return Object.freeze(out);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function readPluginUx(value: unknown): AcpBackendSpecV1['ux'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = readOptionalString(value.name);
  const title = readOptionalString(value.title);
  const description = readOptionalString(value.description);
  const defaultMode = readOptionalString(value.defaultMode);
  const defaultModel = readOptionalString(value.defaultModel);
  const ux = {
    ...(name ? { name } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(defaultMode ? { defaultMode } : {}),
    ...(defaultModel ? { defaultModel } : {}),
  };
  return Object.keys(ux).length > 0
    ? Object.freeze(ux)
    : undefined;
}

function createRuntimeUx(params: Readonly<{
  backendId: string;
  ux?: AcpBackendSpecV1['ux'];
}>): AcpRuntimeDefinitionInitV1['ux'] {
  const name = readOptionalString(params.ux?.name);
  const description = readOptionalString(params.ux?.description);
  const defaultMode = readOptionalString(params.ux?.defaultMode);
  const defaultModel = readOptionalString(params.ux?.defaultModel);
  const title = readOptionalString(params.ux?.title)
    ?? name
    ?? params.backendId;
  return Object.freeze({
    ...(name ? { name } : {}),
    title,
    ...(description ? { description } : {}),
    ...(defaultMode ? { defaultMode } : {}),
    ...(defaultModel ? { defaultModel } : {}),
  });
}

function requireFinalPluginAcpEngine(backend: unknown): AcpBackendSpecV1 {
  if (!isRecord(backend)) {
    throw new Error('Plugin ACP backend contributions must use backends[].engine.kind = acp.');
  }
  const engine = backend.engine;
  if ('acp' in backend || (!isRecord(engine) && backend.runtimeKind === 'acp')) {
    throw new Error('Plugin ACP backend contributions must use backends[].engine.kind = acp; legacy .acp/runtimeKind wire is not supported.');
  }
  if (!isRecord(engine) || engine.kind !== 'acp') {
    throw new Error('Plugin ACP backend contributions must use backends[].engine.kind = acp.');
  }
  const backendId = typeof backend.id === 'string' ? backend.id : '';
  if (backendId.length === 0) {
    throw new Error('Plugin ACP backend contributions require a backend id.');
  }
  const ux = readPluginUx(engine.ux);
  const launchEnv = readStringRecord(engine.launchEnv);
  return {
    backendId,
    transport: engine.transport as AcpBackendSpecV1['transport'],
    ...(ux ? { ux } : {}),
    ...(launchEnv ? { launchEnv } : {}),
    ...(isRecord(engine.capabilities) ? { capabilities: engine.capabilities as AcpBackendSpecV1['capabilities'] } : {}),
    ...(isRecord(engine.auth) ? { auth: engine.auth as AcpBackendSpecV1['auth'] } : {}),
    ...(typeof engine.fsEnabled === 'boolean' ? { fsEnabled: engine.fsEnabled } : {}),
    ...(isRecord(engine.transportLifecycle) ? { transportLifecycle: engine.transportLifecycle as AcpBackendSpecV1['transportLifecycle'] } : {}),
    ...(isRecord(engine.permissionModeArgv) ? { permissionModeArgv: engine.permissionModeArgv as AcpBackendSpecV1['permissionModeArgv'] } : {}),
    ...(typeof engine.sessionIdHeaderName === 'string' ? { sessionIdHeaderName: engine.sessionIdHeaderName } : {}),
    ...(isRecord(engine.toolNameInference) ? { toolNameInference: engine.toolNameInference as AcpBackendSpecV1['toolNameInference'] } : {}),
    ...(isRecord(engine.stderrRules) ? { stderrRules: engine.stderrRules as AcpBackendSpecV1['stderrRules'] } : {}),
    ...(isRecord(engine.permissionOptionSelection) ? { permissionOptionSelection: engine.permissionOptionSelection as AcpBackendSpecV1['permissionOptionSelection'] } : {}),
    ...(isRecord(engine.bootstrap) ? { bootstrap: engine.bootstrap as AcpBackendSpecV1['bootstrap'] } : {}),
    ...(isRecord(engine.messageMeta) ? { messageMeta: engine.messageMeta as AcpBackendSpecV1['messageMeta'] } : {}),
    ...(isRecord(engine.mcp) ? { mcp: engine.mcp as AcpBackendSpecV1['mcp'] } : {}),
    ...(isRecord(engine.callbacks) ? { callbacks: engine.callbacks as AcpBackendSpecV1['callbacks'] } : {}),
  };
}

function buildPluginDefinitionInit(params: Readonly<{
  pluginId?: string;
  spec: AcpBackendSpecV1;
}>): AcpRuntimeDefinitionInitV1 {
  return {
    backendId: params.spec.backendId,
    source: {
      kind: 'plugin_contributed',
      ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    },
    identity: {
      backendId: params.spec.backendId,
    },
    ux: createRuntimeUx({
      backendId: params.spec.backendId,
      ux: params.spec.ux,
    }),
    transport: params.spec.transport,
    launchEnv: params.spec.launchEnv ?? {},
    capabilities: params.spec.capabilities ?? {},
    ...(params.spec.transport.timeouts ? { timeouts: params.spec.transport.timeouts } : {}),
    ...(params.spec.auth ? { auth: params.spec.auth } : {}),
    ...(typeof params.spec.fsEnabled === 'boolean' ? { fsEnabled: params.spec.fsEnabled } : {}),
    ...(params.spec.transportLifecycle ? { transportLifecycle: params.spec.transportLifecycle } : {}),
    ...(params.spec.permissionModeArgv ? { permissionModeArgv: params.spec.permissionModeArgv } : {}),
    ...(params.spec.sessionIdHeaderName ? { sessionIdHeaderName: params.spec.sessionIdHeaderName } : {}),
    ...(params.spec.toolNameInference ? { toolNameInference: params.spec.toolNameInference } : {}),
    ...(params.spec.stderrRules ? { stderrRules: params.spec.stderrRules } : {}),
    ...(params.spec.permissionOptionSelection ? { permissionOptionSelection: params.spec.permissionOptionSelection } : {}),
    ...(params.spec.bootstrap ? { bootstrap: params.spec.bootstrap } : {}),
    ...(params.spec.messageMeta ? { messageMeta: params.spec.messageMeta } : {}),
    mcp: params.spec.mcp ?? {
      policy: 'pass_through',
    },
    callbacks: params.spec.callbacks ?? {},
  };
}

export function normalizePluginAcpDefinition(params: Readonly<{
  pluginId?: string;
  spec: AcpBackendSpecV1;
}>): AcpRuntimeDefinitionV1 {
  return createAcpRuntimeDefinition(buildPluginDefinitionInit(params));
}

export function normalizePluginBackendContributionAcpDefinition(params: Readonly<{
  pluginId?: string;
  backend: unknown;
}>): AcpRuntimeDefinitionV1 {
  return normalizePluginAcpDefinition({
    pluginId: params.pluginId,
    spec: requireFinalPluginAcpEngine(params.backend),
  });
}
