import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { ExistingSessionHandoffStateResolver } from '@/backends/types';
import { verifyResumeReachableClaude } from '@/backends/claude/connectedServices/verifyResumeReachableClaude';
import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import { resolveClaudeConfigDirEnvOverlay } from '@/backends/claude/utils/resolveClaudeConfigDirEnvOverlay';
import { ExistingSessionStateUnavailableError } from '@/session/handoff/sessionHandoffErrors';

export const resolveExistingClaudeSessionHandoffState: ExistingSessionHandoffStateResolver = async (params) => {
  const reachability = await verifyResumeReachableClaude({
    vendorResumeId: params.vendorResumeId,
    processEnv: params.env,
    targetStrict: true,
  });
  if (!reachability.ok || !reachability.resolvedPath
    || !(await stat(reachability.resolvedPath).catch(() => null))?.isFile()) {
    throw new ExistingSessionStateUnavailableError('Claude existing native session is unreachable');
  }
  const configDir = resolveConfiguredClaudeConfigDir({ env: params.env });
  return {
    remoteSessionId: params.vendorResumeId,
    directSource: { kind: 'claudeConfig', configDir, projectId: basename(dirname(reachability.resolvedPath)) },
    resume: {
      directory: params.targetPath,
      agent: 'claude',
      resume: params.vendorResumeId,
      environmentVariables: resolveClaudeConfigDirEnvOverlay(params.env),
      transcriptStorage: params.sessionStorageMode,
      approvedNewDirectoryCreation: true,
    },
  };
};
