import { join } from 'node:path';
import type { SessionMediaTransferConfig } from './resolveSessionMediaTransferTarget';
import { ensureFileContainsRule, resolveGitDirBestEffort, toWorkspaceIgnoreRule } from './ensureAttachmentIgnoreRule';

export async function ensureSessionMediaIgnoreRule(params: Readonly<{
  workingDirectory: string;
  config: SessionMediaTransferConfig;
}>): Promise<void> {
  if (
    params.config.uploadLocation !== 'workspace'
    || !params.config.vcsIgnoreWritesEnabled
    || params.config.vcsIgnoreStrategy === 'none'
  ) {
    return;
  }

  const ruleLine = toWorkspaceIgnoreRule(params.config.workspaceRelativeDir);
  if (params.config.vcsIgnoreStrategy === 'git_info_exclude') {
    const gitDir = await resolveGitDirBestEffort(params.workingDirectory);
    await ensureFileContainsRule(
      gitDir ? join(gitDir, 'info', 'exclude') : join(params.workingDirectory, '.gitignore'),
      ruleLine,
    );
    return;
  }

  await ensureFileContainsRule(join(params.workingDirectory, '.gitignore'), ruleLine);
}
