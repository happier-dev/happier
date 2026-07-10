import type { AcpTier2ArgvBuilderV1 } from '@happier-dev/plugin-sdk/experimental/acp';

import { readAuggieAllowIndexingFromEnv } from '../options/allowIndexing.js';
import { buildAuggiePermissionArgs } from '../permissions/permissionArgs.js';

export const buildAuggieAcpArgv: AcpTier2ArgvBuilderV1 = (params) => {
  const args = [...params.baseArgs];
  if (readAuggieAllowIndexingFromEnv(params.env)) {
    args.push('--allow-indexing');
  }
  args.push(...buildAuggiePermissionArgs(params.permissionMode));
  return args;
};
