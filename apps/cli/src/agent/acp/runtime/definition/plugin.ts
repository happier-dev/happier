import { PluginAgentAcpTransportSchema } from '@happier-dev/protocol';

import type {
  AcpRuntimeDefinitionInit,
  AcpRuntimeDefinition,
  HostAcpBackendSpec,
} from './_types';
import { createAcpRuntimeDefinition } from './create';

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

function readLocalizedString(value: unknown): string | undefined {
  const direct = readOptionalString(value);
  if (direct) return direct;
  return isRecord(value) ? readOptionalString(value.fallback) : undefined;
}

function readPluginUx(value: unknown): HostAcpBackendSpec['ux'] | undefined {
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

function readPluginTransport(
  backendId: string,
  pluginId: string | undefined,
  value: unknown,
): HostAcpBackendSpec['transport'] {
  const transport = PluginAgentAcpTransportSchema.parse(value);
  const timeouts = transport.timeouts
    ? {
        ...(transport.timeouts.initializeMs ? { initMs: transport.timeouts.initializeMs } : {}),
        ...(transport.timeouts.idleMs ? { idleMs: transport.timeouts.idleMs } : {}),
        ...(transport.timeouts.toolCallMs ? { toolCallMs: transport.timeouts.toolCallMs } : {}),
      }
    : undefined;

  if (transport.kind === 'webSocket') {
    return {
      kind: 'ws',
      url: transport.url,
      ...(transport.headers ? { headers: transport.headers } : {}),
      ...(timeouts ? { timeouts } : {}),
    };
  }
  if (transport.kind === 'tcp') {
    return {
      kind: 'tcp',
      host: transport.host,
      port: transport.port,
      ...(timeouts ? { timeouts } : {}),
    };
  }
  if (transport.executable.kind === 'managedDependency') {
    throw new Error(
      `Plugin ACP backend '${backendId}' uses a managedDependency executable, which the current ACP host runtime cannot launch directly.`,
    );
  }
  const executableReference = transport.executable.id;
  const toolId = typeof executableReference === 'string'
    ? executableReference
    : executableReference.pluginId === pluginId
      ? executableReference.localId
      : null;
  if (!toolId) {
    throw new Error(
      `Plugin ACP backend '${backendId}' uses a cross-plugin system-tool reference, which the current ACP host runtime cannot launch directly.`,
    );
  }
  return {
    kind: 'stdio',
    launch: {
      kind: 'system-tool',
      toolId,
      purpose: `Launch ACP backend ${backendId}`,
      ...(transport.args ? { args: transport.args } : {}),
      ...(transport.env ? { env: transport.env } : {}),
    },
    ...(timeouts ? { timeouts } : {}),
  };
}

function createRuntimeUx(params: Readonly<{
  backendId: string;
  ux?: HostAcpBackendSpec['ux'];
}>): AcpRuntimeDefinitionInit['ux'] {
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

function requireFinalPluginAcpRuntime(
  backend: unknown,
  pluginId?: string,
): HostAcpBackendSpec {
  if (!isRecord(backend)) {
    throw new Error('Plugin ACP backend contributions must use agents[].runtime.kind = acp.');
  }
  const runtime = backend.runtime;
  if ('acp' in backend || 'engine' in backend || (!isRecord(runtime) && backend.runtimeKind === 'acp')) {
    throw new Error('Plugin ACP backend contributions must use agents[].runtime.kind = acp; legacy .acp/runtimeKind/engine wire is not supported.');
  }
  if (!isRecord(runtime) || runtime.kind !== 'acp') {
    throw new Error('Plugin ACP backend contributions must use agents[].runtime.kind = acp.');
  }
  const backendId = typeof backend.id === 'string' ? backend.id : '';
  if (backendId.length === 0) {
    throw new Error('Plugin ACP backend contributions require a backend id.');
  }
  const runtimeUx = readPluginUx(runtime.ux);
  const contributionTitle = readLocalizedString(backend.title);
  const contributionDescription = readLocalizedString(backend.description);
  const ux = runtimeUx || contributionTitle || contributionDescription
    ? Object.freeze({
        ...(contributionTitle ? { title: contributionTitle } : {}),
        ...(contributionDescription ? { description: contributionDescription } : {}),
        ...runtimeUx,
      })
    : undefined;
  const launchEnv = readStringRecord(runtime.launchEnv);
  return {
    backendId,
    transport: readPluginTransport(backendId, pluginId, runtime.transport),
    ...(ux ? { ux } : {}),
    ...(launchEnv ? { launchEnv } : {}),
    ...(isRecord(runtime.capabilities) ? { capabilities: runtime.capabilities as HostAcpBackendSpec['capabilities'] } : {}),
    ...(isRecord(runtime.auth) ? { auth: runtime.auth as HostAcpBackendSpec['auth'] } : {}),
    ...(typeof runtime.fsEnabled === 'boolean' ? { fsEnabled: runtime.fsEnabled } : {}),
    ...(isRecord(runtime.transportLifecycle) ? { transportLifecycle: runtime.transportLifecycle as HostAcpBackendSpec['transportLifecycle'] } : {}),
    ...(isRecord(runtime.permissionModeArgv) ? { permissionModeArgv: runtime.permissionModeArgv as HostAcpBackendSpec['permissionModeArgv'] } : {}),
    ...(typeof runtime.sessionIdHeaderName === 'string' ? { sessionIdHeaderName: runtime.sessionIdHeaderName } : {}),
    ...(isRecord(runtime.toolNameInference) ? { toolNameInference: runtime.toolNameInference as HostAcpBackendSpec['toolNameInference'] } : {}),
    ...(isRecord(runtime.stderrRules) ? { stderrRules: runtime.stderrRules as HostAcpBackendSpec['stderrRules'] } : {}),
    ...(isRecord(runtime.permissionOptionSelection) ? { permissionOptionSelection: runtime.permissionOptionSelection as HostAcpBackendSpec['permissionOptionSelection'] } : {}),
    ...(isRecord(runtime.messageMeta) ? { messageMeta: runtime.messageMeta as HostAcpBackendSpec['messageMeta'] } : {}),
    ...(isRecord(runtime.mcp) ? { mcp: runtime.mcp as HostAcpBackendSpec['mcp'] } : {}),
    ...(isRecord(runtime.callbacks) ? { callbacks: runtime.callbacks as HostAcpBackendSpec['callbacks'] } : {}),
  };
}

function buildPluginDefinitionInit(params: Readonly<{
  pluginId?: string;
  spec: HostAcpBackendSpec;
}>): AcpRuntimeDefinitionInit {
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
    ...(params.spec.messageMeta ? { messageMeta: params.spec.messageMeta } : {}),
    mcp: params.spec.mcp ?? {
      policy: 'pass_through',
    },
    callbacks: params.spec.callbacks ?? {},
  };
}

export function normalizePluginAcpDefinition(params: Readonly<{
  pluginId?: string;
  spec: HostAcpBackendSpec;
}>): AcpRuntimeDefinition {
  return createAcpRuntimeDefinition(buildPluginDefinitionInit(params));
}

export function normalizePluginBackendContributionAcpDefinition(params: Readonly<{
  pluginId?: string;
  backend: unknown;
}>): AcpRuntimeDefinition {
  return normalizePluginAcpDefinition({
    pluginId: params.pluginId,
    spec: requireFinalPluginAcpRuntime(params.backend, params.pluginId),
  });
}
