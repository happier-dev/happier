export const GIT_INSTALLABLE_DEP_ID = 'git-cli';

export const GIT_INSTALLABLE_DESCRIPTOR = Object.freeze({
  id: GIT_INSTALLABLE_DEP_ID,
  title: 'Git',
  description: 'Git command line executable used for local source-control operations.',
  sources: [{ kind: 'system' as const, executableNames: ['git'], versionArguments: ['--version'] }],
  executable: 'git',
});
