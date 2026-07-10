import type {
  AcpTier2ArgvBuilderV1,
  AcpTier2EnvBuilderV1,
} from '@happier-dev/plugin-sdk/experimental/acp';
import { normalizeAcpPermissionIntent } from '@happier-dev/plugin-sdk/experimental/acp';

import { ensureKimiReadOnlyAgentFile } from '../bootstrap/readonlyAgentFile.js';
import { HAPPIER_KIMI_ACP_SELECTOR_ENV } from '../preferences/pythonSelector.js';
import { resolveKimiAcpPythonSelectorChildEnv } from './pythonSelectorEnv.js';

export const buildKimiAcpArgv: AcpTier2ArgvBuilderV1 = (params) => {
  const intent = normalizeAcpPermissionIntent(params.permissionMode);
  const args: string[] = ['--work-dir', params.cwd];

  if (intent === 'yolo') {
    args.push('--yolo');
  }

  if (intent === 'read-only' || intent === 'plan') {
    args.push('--agent-file', ensureKimiReadOnlyAgentFile());
  }

  args.push(...params.baseArgs);
  return args;
};

export const buildKimiAcpEnv: AcpTier2EnvBuilderV1 = (params) => resolveKimiAcpPythonSelectorChildEnv({
  selector: params.env[HAPPIER_KIMI_ACP_SELECTOR_ENV],
  env: params.env,
  inheritedEnv: params.env,
});
