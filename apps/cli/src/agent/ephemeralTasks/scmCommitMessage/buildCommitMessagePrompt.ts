import type { ScmWorkingSnapshot } from '@happier-dev/protocol';

type ScmSnapshotEntry = Readonly<{
  path: string;
  kind?: unknown;
  hasIncludedDelta?: boolean;
  hasPendingDelta?: boolean;
  pendingStatus?: unknown;
  includeStatus?: unknown;
  stats?: Readonly<{ pendingAdded?: number; pendingRemoved?: number }> | null;
}>;

function isScmSnapshotEntry(value: unknown): value is ScmSnapshotEntry {
  if (!value || typeof value !== 'object') return false;
  const anyValue = value as { path?: unknown };
  return typeof anyValue.path === 'string' && anyValue.path.trim().length > 0;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars - 1)) + '…';
}

export function buildCommitMessagePrompt(params: Readonly<{
  snapshot: ScmWorkingSnapshot;
  diffsByPath: ReadonlyArray<{ path: string; diff: string }>;
  instructions?: string;
}>): string {
  const branch = params.snapshot.branch?.head ?? 'unknown';
  const repoRoot = params.snapshot.repo?.rootPath ?? '(unknown root)';

  const rawEntries = Array.isArray(params.snapshot.entries) ? params.snapshot.entries : [];
  const entries = rawEntries.filter(isScmSnapshotEntry);
  const changed = entries
    .filter((e) => Boolean(e.hasIncludedDelta || e.hasPendingDelta || e.pendingStatus || e.includeStatus))
    .slice(0, 50)
    .map((e) => {
      const included = e.hasIncludedDelta ? 'included' : 'not-included';
      const pending = e.hasPendingDelta ? 'pending' : 'no-pending';
      const kind = typeof e.kind === 'string' && e.kind.trim() ? e.kind.trim() : 'unknown';
      const added = e.stats?.pendingAdded ?? 0;
      const removed = e.stats?.pendingRemoved ?? 0;
      return `- ${e.path} (${kind}) [${included}/${pending}] (+${added}/-${removed})`;
    })
    .join('\n');

  const diffBlocks = params.diffsByPath
    .slice(0, 10)
    .map((d) => `### ${d.path}\n${truncate(d.diff, 12_000)}`)
    .join('\n\n');

  const extra = typeof params.instructions === 'string' && params.instructions.trim().length > 0
    ? `\n\nUser instructions:\n${params.instructions.trim()}\n`
    : '';

  return [
    'Commit message generator.',
    '',
    'You MUST return ONLY valid JSON in this shape:',
    '{',
    '  "title": string,',
    '  "body": string,',
    '  "message": string,',
    '  "confidence"?: number',
    '}',
    '',
    'Rules:',
    '- title should be <= 72 characters when possible.',
    '- body can be empty.',
    '- message MUST equal title + optional blank line + body.',
    '- do not include markdown fences.',
    '',
    `Repo: ${repoRoot}`,
    `Branch: ${branch}`,
    '',
    'Changed files (bounded):',
    changed || '(none)',
    '',
    'Diff excerpts (bounded):',
    diffBlocks || '(no diffs)',
    extra,
  ].join('\n');
}
