import {
  PluginAgentContributionV2Schema,
  PluginAgentRuntimeAcpV2Schema,
} from '@happier-dev/protocol';
import type {
  PluginAgentAcpTransport,
} from '@happier-dev/protocol';
import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';

import type {
  AcpRuntimeDefinition,
  AcpRuntimeDefinitionInit,
  HostAcpTransportSpec,
} from './_types';
import { createAcpRuntimeDefinition } from './create';

const NEUTRAL_ACP_MCP_POLICY = Object.freeze({
  policy: 'drop' as const,
});

export type NormalizedPluginDeclarativeAcpRuntime = Readonly<{
  transport: PluginAgentAcpTransport;
  definition?: NonNullable<AgentAcpRuntimeOptions['definition']>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readLocalizedString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const fallback = value.fallback;
  return typeof fallback === 'string' && fallback.trim().length > 0
    ? fallback
    : undefined;
}

/**
 * Normalizes the one strict Protocol declaration into the existing public ACP
 * composer options. Omitted MCP policy deliberately keeps the composer's
 * neutral no-delivery behavior.
 */
export function normalizePluginDeclarativeAcpRuntime(
  runtime: unknown,
): NormalizedPluginDeclarativeAcpRuntime {
  const parsed = PluginAgentRuntimeAcpV2Schema.parse(runtime);
  const definition = parsed.definition
    ? Object.freeze({
      ...(parsed.definition.modelConfigOptionId
        ? { modelConfigOptionId: parsed.definition.modelConfigOptionId }
        : {}),
      ...(parsed.definition.stderrRules
        ? { stderrRules: parsed.definition.stderrRules }
        : {}),
      mcp: parsed.definition.mcp ?? NEUTRAL_ACP_MCP_POLICY,
    }) satisfies NonNullable<AgentAcpRuntimeOptions['definition']>
    : undefined;

  return Object.freeze({
    transport: parsed.transport,
    ...(definition ? { definition } : {}),
  });
}

function normalizePluginAcpTransport(params: Readonly<{
  backendId: string;
  pluginId?: string;
  transport: PluginAgentAcpTransport;
}>): HostAcpTransportSpec {
  const timeouts = params.transport.timeouts
    ? {
        ...(params.transport.timeouts.initializeMs
          ? { initMs: params.transport.timeouts.initializeMs }
          : {}),
        ...(params.transport.timeouts.idleMs
          ? { idleMs: params.transport.timeouts.idleMs }
          : {}),
        ...(params.transport.timeouts.toolCallMs
          ? { toolCallMs: params.transport.timeouts.toolCallMs }
          : {}),
      }
    : undefined;

  if (params.transport.kind === 'webSocket') {
    return {
      kind: 'ws',
      url: params.transport.url,
      ...(params.transport.headers ? { headers: params.transport.headers } : {}),
      ...(timeouts ? { timeouts } : {}),
    };
  }
  if (params.transport.kind === 'tcp') {
    return {
      kind: 'tcp',
      host: params.transport.host,
      port: params.transport.port,
      ...(timeouts ? { timeouts } : {}),
    };
  }
  if (params.transport.executable.kind === 'managedDependency') {
    throw new Error(
      `Plugin ACP backend '${params.backendId}' uses a managedDependency executable, which the current ACP host runtime cannot launch directly.`,
    );
  }
  const executableReference = params.transport.executable.id;
  const toolId = typeof executableReference === 'string'
    ? executableReference
    : executableReference.pluginId === params.pluginId
      ? executableReference.localId
      : null;
  if (!toolId) {
    throw new Error(
      `Plugin ACP backend '${params.backendId}' uses a cross-plugin system-tool reference, which the current ACP host runtime cannot launch directly.`,
    );
  }
  return {
    kind: 'stdio',
    launch: {
      kind: 'system-tool',
      toolId,
      purpose: `Launch ACP backend ${params.backendId}`,
      ...(params.transport.args ? { args: params.transport.args } : {}),
      ...(params.transport.env ? { env: params.transport.env } : {}),
    },
    ...(timeouts ? { timeouts } : {}),
  };
}

function requirePluginAcpAgentContribution(backend: unknown): unknown {
  if (!isRecord(backend)) {
    throw new Error('Plugin ACP backend contributions must use agents[].runtime.kind = acp.');
  }
  const runtime = backend.runtime;
  if (
    'acp' in backend
    || 'engine' in backend
    || (!isRecord(runtime) && backend.runtimeKind === 'acp')
  ) {
    throw new Error('Plugin ACP backend contributions must use agents[].runtime.kind = acp; legacy .acp/runtimeKind/engine wire is not supported.');
  }
  return backend;
}

export function normalizePluginBackendContributionAcpDefinition(params: Readonly<{
  pluginId?: string;
  backend: unknown;
}>): AcpRuntimeDefinition {
  const agent = PluginAgentContributionV2Schema.parse(
    requirePluginAcpAgentContribution(params.backend),
  );
  if (!('runtime' in agent) || agent.runtime.kind !== 'acp') {
    throw new Error('Plugin ACP backend contributions must use agents[].runtime.kind = acp.');
  }

  const runtime = normalizePluginDeclarativeAcpRuntime(agent.runtime);
  const transport = normalizePluginAcpTransport({
    backendId: agent.id,
    pluginId: params.pluginId,
    transport: runtime.transport,
  });
  const sessionCapabilities = 'primary' in agent && agent.primary === 'sessions'
    ? agent.capabilities.sessions
    : null;
  const title = readLocalizedString(agent.title) ?? agent.id;
  const description = readLocalizedString(agent.description);
  const definitionInit: AcpRuntimeDefinitionInit = {
    backendId: agent.id,
    source: {
      kind: 'plugin_contributed',
      ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    },
    identity: {
      backendId: agent.id,
    },
    ux: {
      title,
      ...(description ? { description } : {}),
    },
    transport,
    launchEnv: {},
    capabilities: {
      supportsResume: sessionCapabilities?.open.includes('resume') === true,
    },
    ...(transport.timeouts ? { timeouts: transport.timeouts } : {}),
    ...(runtime.definition?.stderrRules
      ? { stderrRules: runtime.definition.stderrRules }
      : {}),
    mcp: runtime.definition?.mcp ?? NEUTRAL_ACP_MCP_POLICY,
  };
  return createAcpRuntimeDefinition(definitionInit);
}
