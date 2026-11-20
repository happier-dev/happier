import type { ReviewScmScopeV1 } from '@happier-dev/plugin-sdk/reviews';
import { isPluginActionApprovalRequestCreated, type ActionsService,
  type ActionApprovalRequestCreatedResult, type PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

import type { DeepSecReviewMode } from './command.js';

/** DeepSec selects names, then reads current root bytes rather than the named revision's bytes. */
export async function preflightDeepSecReviewScope(params: Readonly<{
  cwd: string;
  mode: DeepSecReviewMode;
  scope?: ReviewScmScopeV1 | null;
  actions?: Pick<ActionsService, 'execute'>;
  signal: AbortSignal;
}>): Promise<DeepSecReviewMode> {
  const scope = params.scope ?? null;
  const captured = scope?.comparison || scope?.revisionRange;
  const unsupported = () => new Error('DeepSec requires the captured comparison to match this live checkout HEAD and whole working-tree or clean committed scope. Choose another reviewer for this subject.');
  if (captured && params.mode === 'repository_security_audit') throw unsupported();
  if (params.mode === 'repository_security_audit') return params.mode;
  if (!scope) throw new Error('DeepSec review requires host-resolved SCM scope facts.');
  if (scope.status !== 'supported') {
    throw new Error(scope.diagnostics[0]?.message || 'DeepSec review requires a source-control repository in the current session scope.');
  }
  if (scope.scmMode !== '.git') throw new Error('DeepSec review requires a git worktree in the current session scope.');
  if (!captured) return params.mode;

  const comparison = scope.comparison;
  const workingTree = comparison?.source.kind === 'workingTree';
  if (workingTree) {
    if ((comparison.source.area ?? 'both') !== 'both') throw unsupported();
  } else if (comparison && comparison.source.kind !== 'branch' && comparison.source.kind !== 'commit'
    && comparison.source.kind !== 'revisionRange' && comparison.source.kind !== 'pullRequest') throw unsupported();

  const unavailable = () => new Error('DeepSec cannot read live SCM checkout facts for this captured comparison.');
  if (!params.actions) throw unavailable();
  let status: PluginActionResultById['scm.status.snapshot'] | ActionApprovalRequestCreatedResult;
  try {
    status = await params.actions.execute('scm.status.snapshot', {
      cwd: params.cwd, includeWorktreeStatus: false,
      // Facts omit working-copy status. Committed captures need the full tracked-change inventory.
      ...(workingTree ? { detail: 'facts' } : {}),
    }, { signal: params.signal });
  } catch {
    throw unavailable();
  } finally {
    params.signal.throwIfAborted();
  }
  if (isPluginActionApprovalRequestCreated(status) || !status.success || !status.snapshot?.repo.isRepo
    || status.snapshot.repo.mode !== '.git' || !status.snapshot.branch.headOid) throw unavailable();
  const snapshot = status.snapshot;
  if (snapshot.repo.rootPath !== scope.repositoryRoot) throw unsupported();
  if (workingTree) {
    if (comparison.endpoints.before !== snapshot.branch.headOid) throw unsupported();
  } else {
    const before = comparison?.endpoints.before ?? scope.revisionRange?.baseOid;
    const after = comparison?.endpoints.after ?? scope.revisionRange?.headOid;
    if (!before || after !== snapshot.branch.headOid) throw unsupported();
    if (snapshot.entries.some(entry => entry.kind !== 'untracked' && (entry.hasIncludedDelta || entry.hasPendingDelta))) {
      throw new Error('DeepSec reads current root files; this captured committed comparison requires a clean tracked checkout. Choose another reviewer or remove the tracked checkout changes.');
    }
  }
  // Host-captured paths, not native staged/working selectors, own the exact file selection.
  return 'current_diff';
}
