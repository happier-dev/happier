// Backwards-compatible git alias for SCM status file helpers.
export * from '@/scm/scmStatusFiles';

// Legacy names used by older git-only components/tests.
export type { ScmFileStatus as GitFileStatus, ScmStatusFiles as GitStatusFiles } from '@/scm/scmStatusFiles';
export { snapshotToScmStatusFiles as snapshotToGitStatusFiles } from '@/scm/scmStatusFiles';
