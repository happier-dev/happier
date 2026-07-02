import type {
  AcpTier2ArgvBuilderV1,
  AcpTier2EnvBuilderV1,
} from '@happier-dev/plugin-sdk/acp';

import { ensureKimiReadOnlyAgentFile } from '../bootstrap/readonlyAgentFile.js';
import { resolveKimiAcpPythonSelectorChildEnv } from './pythonSelectorEnv.js';

function normalizePermissionMode(mode: string | null | undefined): string {
  const normalized = String(mode ?? 'default').trim();
  if (!normalized) return 'default';
  if (normalized === 'read_only') return 'read-only';
  return normalized;
}

export const buildKimiAcpArgv: AcpTier2ArgvBuilderV1 = (params) => {
  const intent = normalizePermissionMode(params.permissionMode);
  const args: string[] = ['--work-dir', params.cwd];

  if (intent === 'yolo' || intent === 'bypassPermissions') {
    args.push('--yolo');
  }

  if (intent === 'read-only' || intent === 'plan') {
    args.push('--agent-file', ensureKimiReadOnlyAgentFile());
  }

  args.push(...params.baseArgs);
  return args;
};

export const buildKimiAcpEnv: AcpTier2EnvBuilderV1 = (params) => resolveKimiAcpPythonSelectorChildEnv({
  selector: params.env.HAPPIER_KIMI_ACP_SELECTOR,
  env: params.env,
  inheritedEnv: params.env,
});
