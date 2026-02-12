import type { ScmDiffArea } from '@happier-dev/protocol';

export const SCM_GIT_REPO_BACKEND_OPTIONS = ['git', 'sapling'] as const;
export type ScmGitRepoPreferredBackend = (typeof SCM_GIT_REPO_BACKEND_OPTIONS)[number];

export const SCM_REMOTE_CONFIRM_POLICIES = ['always', 'push_only', 'never'] as const;
export type ScmRemoteConfirmPolicy = (typeof SCM_REMOTE_CONFIRM_POLICIES)[number];

export const SCM_PUSH_REJECT_POLICIES = ['prompt_fetch', 'auto_fetch', 'manual'] as const;
export type ScmPushRejectPolicy = (typeof SCM_PUSH_REJECT_POLICIES)[number];

export const SCM_DIFF_MODE_OPTIONS = ['included', 'pending', 'both'] as const satisfies readonly ScmDiffArea[];
export type ScmDefaultDiffMode = (typeof SCM_DIFF_MODE_OPTIONS)[number];
