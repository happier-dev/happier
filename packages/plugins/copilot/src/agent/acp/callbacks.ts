import { parsePermissionIntentAlias } from '@happier-dev/agents';
import type { AcpTier2ArgvBuilderV1 } from '@happier-dev/plugin-sdk/acp';

export const buildCopilotAcpArgv: AcpTier2ArgvBuilderV1 = ({ baseArgs, permissionMode }) => {
  const intent = parsePermissionIntentAlias(permissionMode ?? 'default') ?? 'default';
  return intent === 'yolo'
    ? [...baseArgs, '--yolo']
    : [...baseArgs];
};
