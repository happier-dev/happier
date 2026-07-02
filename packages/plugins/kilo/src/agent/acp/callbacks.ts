import type { AcpTier2EnvBuilderV1 } from '@happier-dev/plugin-sdk/acp';

import { buildKiloOpenCodePermissionEnv } from '../permissions/opencodePermissionPolicy.js';

export const buildKiloAcpEnv: AcpTier2EnvBuilderV1 = ({ env, permissionMode }) => buildKiloOpenCodePermissionEnv({
  env,
  permissionMode,
});
