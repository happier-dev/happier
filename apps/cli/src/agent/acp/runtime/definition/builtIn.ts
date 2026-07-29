import {
  getBuiltInAcpConfig,
  type BuiltInAcpYesNoAuto,
  type AgentId,
} from '@happier-dev/agents';

import type { AcpRuntimeDefinition } from './_types';
import { createAcpRuntimeDefinition } from './create';

function normalizeBuiltInSupportFlag(value: BuiltInAcpYesNoAuto): boolean | 'unknown' {
  if (value === 'yes') {
    return true;
  }
  if (value === 'no') {
    return false;
  }
  return 'unknown';
}

function normalizeBuiltInPromptImageSupport(value: BuiltInAcpYesNoAuto): 'yes' | 'no' | 'unknown' {
  return value === 'auto' ? 'unknown' : value;
}

export function normalizeBuiltInAcpDefinition(agentId: AgentId): AcpRuntimeDefinition {
  const config = getBuiltInAcpConfig(agentId);
  if (!config) {
    throw new Error(`No built-in ACP runtime definition is configured for agent '${agentId}'.`);
  }
  const promptImageSupport = normalizeBuiltInPromptImageSupport(config.promptImageSupport);
  return createAcpRuntimeDefinition({
    backendId: agentId,
    source: {
      kind: 'built_in',
    },
    identity: {
      agentId,
      backendId: agentId,
    },
    ux: {
      name: agentId,
      title: agentId,
    },
    transport: {
      kind: 'stdio',
      launch: {
        kind: 'agent-cli',
        agentId,
        args: [...config.launcher.args],
      },
    },
    capabilities: {
      supportsResume: config.supportsLoadSession,
      supportsModes: normalizeBuiltInSupportFlag(config.supportsModes),
      supportsModels: normalizeBuiltInSupportFlag(config.supportsModels),
      supportsConfigOptions: false,
      supportsPromptImages: normalizeBuiltInSupportFlag(config.promptImageSupport),
      promptImageSupport,
      supportsToolUse: true,
      supportsPermissionRequests: true,
    },
    mcp: {
      policy: 'pass_through',
    },
  });
}
