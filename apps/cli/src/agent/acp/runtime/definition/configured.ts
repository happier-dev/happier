import type { ResolvedConfiguredAcpBackend } from '@/agent/acp/catalog/configured/resolveBackend';

import type {
  AcpRuntimeDefinitionInit,
  AcpRuntimeDefinition,
  HostAcpAuthSpec,
} from './_types';
import { createAcpRuntimeDefinition } from './create';

type ConfiguredSupportFlag = boolean | 'yes' | 'no' | 'unknown';

function normalizeSupportFlag(value: ConfiguredSupportFlag | undefined): boolean | 'unknown' | undefined {
  if (value === true || value === 'yes') {
    return true;
  }
  if (value === false || value === 'no') {
    return false;
  }
  return value;
}

function normalizeConfiguredAuth(auth: ResolvedConfiguredAcpBackend['auth']): HostAcpAuthSpec | undefined {
  if (!auth) {
    return undefined;
  }

  return {
    config: auth,
  };
}

function buildConfiguredDefinitionInit(params: Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  launchEnv?: Readonly<Record<string, string>>;
}>): AcpRuntimeDefinitionInit {
  const capabilities = params.backend.capabilities;
  const auth = normalizeConfiguredAuth(params.backend.auth);
  const launch = params.backend.launch ?? {
    kind: 'executable' as const,
    command: params.backend.command,
    args: [...params.backend.args],
  };
  return {
    backendId: params.backend.backendId,
    source: params.backend.source.kind === 'plugin_contributed'
      ? {
          kind: 'plugin_contributed',
          pluginId: params.backend.source.pluginId,
        }
      : { kind: 'account_configured' },
    identity: {
      backendId: params.backend.backendId,
    },
    ux: {
      name: params.backend.name,
      title: params.backend.title,
      ...(params.backend.description ? { description: params.backend.description } : {}),
      ...(params.backend.defaultMode ? { defaultMode: params.backend.defaultMode } : {}),
      ...(params.backend.defaultModel ? { defaultModel: params.backend.defaultModel } : {}),
    },
    transport: {
      kind: 'stdio',
      launch,
    },
    launchEnv: params.launchEnv ?? {},
    capabilities: {
      supportsResume: capabilities.supportsLoadSession,
      supportsModes: normalizeSupportFlag(capabilities.supportsModes),
      supportsModels: normalizeSupportFlag(capabilities.supportsModels),
      supportsConfigOptions: normalizeSupportFlag(capabilities.supportsConfigOptions),
      supportsPromptImages: normalizeSupportFlag(capabilities.promptImageSupport),
      promptImageSupport: capabilities.promptImageSupport,
      supportsToolUse: true,
      supportsPermissionRequests: true,
    },
    ...(params.backend.timeouts ? { timeouts: params.backend.timeouts } : {}),
    ...(auth ? { auth } : {}),
    ...(typeof params.backend.fsEnabled === 'boolean' ? { fsEnabled: params.backend.fsEnabled } : {}),
    ...(params.backend.transportLifecycle ? { transportLifecycle: params.backend.transportLifecycle } : {}),
    ...(params.backend.permissionModeArgv ? { permissionModeArgv: params.backend.permissionModeArgv } : {}),
    ...(params.backend.sessionIdHeaderName ? { sessionIdHeaderName: params.backend.sessionIdHeaderName } : {}),
    ...(params.backend.messageMeta ? { messageMeta: params.backend.messageMeta } : {}),
    mcp: {
      policy: params.backend.mcp?.policy ?? 'pass_through',
    },
  };
}

export function normalizeConfiguredAcpDefinition(params: Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  launchEnv?: Readonly<Record<string, string>>;
}>): AcpRuntimeDefinition {
  return createAcpRuntimeDefinition(buildConfiguredDefinitionInit(params));
}
