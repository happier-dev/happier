import { parsePermissionIntentAlias, type AcpTier2ArgvBuilderV1 } from '@happier-dev/plugin-sdk/experimental/acp';

export const buildCopilotAcpArgv: AcpTier2ArgvBuilderV1 = ({ baseArgs, permissionMode }) => {
  const intent = parsePermissionIntentAlias(permissionMode ?? 'default') ?? 'default';
  return intent === 'yolo'
    ? [...baseArgs, '--yolo']
    : [...baseArgs];
};
