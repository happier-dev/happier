import type { ResolvedConfiguredAcpBackend } from '@/agent/acp/catalog/configured/resolveBackend';
import type { AcpAuthSpecV1 } from '@happier-dev/extension-sdk';

import type {
  AcpRuntimeDefinitionInitV1,
  AcpRuntimeDefinitionV1,
} from './_types';
import { createAcpRuntimeDefinition } from './runtimeCore';

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

function normalizeConfiguredAuth(auth: ResolvedConfiguredAcpBackend['auth']): AcpAuthSpecV1 | undefined {
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
}>): AcpRuntimeDefinitionInitV1 {
  const capabilities = params.backend.capabilities;
  const auth = normalizeConfiguredAuth(params.backend.auth);
  const launch = params.backend.launch ?? {
    kind: 'executable' as const,
    command: params.backend.command,
    args: [...params.backend.args],
  };
  return {
    backendId: params.backend.backendId,
    source: {
      kind: 'account_configured',
    },
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
    ...(auth ? { auth } : {}),
    mcp: {
      policy: 'pass_through',
    },
  };
}

export function normalizeConfiguredAcpDefinition(params: Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  launchEnv?: Readonly<Record<string, string>>;
}>): AcpRuntimeDefinitionV1 {
  return createAcpRuntimeDefinition(buildConfiguredDefinitionInit(params));
}
