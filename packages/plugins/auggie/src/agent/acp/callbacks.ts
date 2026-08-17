import type { AgentSessionConfigurationSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';

import { buildAuggiePermissionIntentArgs } from '../permissions/permissionArgs.js';

function composeAuggieAcpArgv(params: Readonly<{
  baseArgs: readonly string[];
  allowIndexing: boolean;
  permissionArgs: readonly string[];
}>): readonly string[] {
  const args = [...params.baseArgs];
  if (params.allowIndexing) args.push('--allow-indexing');
  args.push(...params.permissionArgs);
  return args;
}

export function buildAuggieAcpArgvFromSessionConfiguration(params: Readonly<{
  baseArgs: readonly string[];
  configuration: AgentSessionConfigurationSnapshot;
}>): readonly string[] {
  return composeAuggieAcpArgv({
    baseArgs: params.baseArgs,
    allowIndexing: params.configuration.options.allowIndexing?.value === true,
    permissionArgs: buildAuggiePermissionIntentArgs(params.configuration.permissionIntent.value),
  });
};
