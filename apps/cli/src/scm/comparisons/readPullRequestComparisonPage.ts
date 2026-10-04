import { z } from 'zod';
import type { FileChangeKind, ScmComparison, ScmComparisonSource } from '@happier-dev/protocol';
import type { GitComparisonFile } from './readGitComparisonFiles';

export type PullRequestComparisonSourceAction = NonNullable<Extract<ScmComparisonSource, { kind: 'pullRequest' }>['locator']['sourceAction']>;

/** Trusted host Action transport, never caller-supplied comparison evidence. */
export type ReadPullRequestComparisonPage = (input: Readonly<{
  sourceAction: PullRequestComparisonSourceAction;
  continuation?: string;
}>) => Promise<unknown>;

// Projection of the source Action's validated changedFiles response. Source admission,
// credentials, native pagination limits and continuation integrity remain source-owned.
const PageSchema = z.object({
  kind: z.literal('changedFiles'),
  rows: z.array(z.object({ path: z.string().min(1), previousPath: z.string().optional(), status: z.string(),
    diffAvailable: z.boolean(), evidence: z.discriminatedUnion('state', [
      z.object({ state: z.literal('available'), patch: z.string() }),
      z.object({ state: z.literal('truncated'), patch: z.string(), reason: z.string() }),
      z.object({ state: z.literal('unavailable'), reason: z.string() }),
    ]).optional(), truncated: z.boolean().optional() }).passthrough()),
  omittedRowCount: z.number().int().nonnegative(), projectionTruncated: z.boolean(),
  incomplete: z.enum(['ceiling', 'pagination']).optional(), continuation: z.string().min(1).optional(),
  comparison: z.object({ beforeOid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
    baseOid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), headOid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
    locator: z.object({ providerId: z.string().min(1), repository: z.string().min(1), number: z.number().int().positive() }).strict().optional(),
    totalFileCount: z.number().int().nonnegative(), enumeratedFileCount: z.number().int().nonnegative(),
    freshness: z.enum(['current', 'stale', 'unverified']), inventory: z.enum(['complete', 'incomplete']),
    content: z.enum(['complete', 'incomplete']), reasons: z.array(z.string()), failure: z.unknown().optional(),
  }).passthrough(),
}).passthrough();

type HostedFile = GitComparisonFile;
type HostedComparison = Readonly<{ before?: string; after?: string; pullRequest?: ScmComparison['pullRequest']; files: readonly HostedFile[];
  reasons: readonly string[]; state: ScmComparison['inventory']['state']; freshness: ScmComparison['freshness'] }>;

function changeKind(status: string): FileChangeKind {
  switch (status) {
    case 'added': return 'added'; case 'removed': case 'deleted': return 'deleted';
    case 'renamed': return 'renamed'; case 'copied': return 'copied';
    case 'modified': case 'changed': return 'modified'; default: return 'unknown';
  }
}

// Git C-style quoting keeps provider paths from becoming diff-header syntax.
function diffPath(path: string): string {
  if (!/[\s"\\\x00-\x1f\x7f]/.test(path)) return path;
  return `"${path.replace(/["\\\x00-\x1f\x7f]/g, (character) => {
    if (character === '"' || character === '\\') return `\\${character}`;
    return `\\${character.charCodeAt(0).toString(8).padStart(3, '0')}`;
  })}"`;
}

function projectRow(row: z.infer<typeof PageSchema>['rows'][number]): HostedFile {
  const kind = changeKind(row.status);
  const patch = row.evidence && row.evidence.state !== 'unavailable' ? row.evidence.patch : undefined;
  const unavailableReason = row.evidence?.state === 'unavailable' || row.evidence?.state === 'truncated'
    ? row.evidence.reason : row.truncated ? 'source_patch_truncated'
      : patch === undefined || !row.diffAvailable ? 'provider_patch_missing' : undefined;
  const beforePath = diffPath(`a/${row.previousPath ?? row.path}`);
  const afterPath = diffPath(`b/${row.path}`);
  const oldPath = kind === 'added' ? '/dev/null' : beforePath;
  const newPath = kind === 'deleted' ? '/dev/null' : afterPath;
  return { path: row.path, ...(row.previousPath ? { previousPath: row.previousPath } : {}), changeKind: kind,
    binary: patch === undefined ? null : /GIT binary patch|Binary files .* differ/i.test(patch),
    ...(patch !== undefined ? { unifiedDiff: `diff --git ${beforePath} ${afterPath}\n--- ${oldPath}\n+++ ${newPath}\n${patch}` } : {}),
    ...(unavailableReason ? { unavailableReason } : {}) };
}

export async function readPullRequestComparison(input: Readonly<{
  source: Extract<ScmComparisonSource, { kind: 'pullRequest' }>; readPage?: ReadPullRequestComparisonPage;
}>): Promise<HostedComparison> {
  const files: HostedFile[] = []; const reasons: string[] = [];
  let before: string | undefined; let after: string | undefined;
  let pullRequest: ScmComparison['pullRequest'];
  let freshness: ScmComparison['freshness'] = 'unknown';
  let continuation: string | undefined; let totalFileCount: number | undefined;
  const continuations = new Set<string>(); const paths = new Set<string>();
  let deliveredCount = 0; let completed = false;
  if (!input.source.locator.sourceAction || !input.readPage) return { files, reasons: ['Configured pull-request source Action is unavailable'], state: 'unavailable', freshness };
  try {
    do {
      const page = PageSchema.parse(await input.readPage({ sourceAction: input.source.locator.sourceAction, ...(continuation ? { continuation } : {}) }));
      const facts = page.comparison;
      if (!facts.locator) reasons.push('Pull-request source did not attest the selected locator');
      else if (facts.locator.providerId !== input.source.locator.providerId
        || facts.locator.repository !== input.source.locator.repository || facts.locator.number !== input.source.locator.number) {
        reasons.push('Pull-request source locator does not match the selected comparison'); break;
      }
      if (!before) {
        before = facts.beforeOid; after = facts.headOid; totalFileCount = facts.totalFileCount;
        pullRequest = { baseOid: facts.baseOid };
        if ((input.source.locator.baseOid && input.source.locator.baseOid !== pullRequest.baseOid)
          || (input.source.locator.headOid && input.source.locator.headOid !== after)) {
          reasons.push('Selected pull-request endpoint no longer matches the source'); freshness = 'stale'; break;
        }
      } else if (before !== facts.beforeOid || pullRequest?.baseOid !== facts.baseOid || after !== facts.headOid || totalFileCount !== facts.totalFileCount) {
        reasons.push('Pull-request source changed during pagination'); freshness = 'stale'; break;
      }
      freshness = facts.freshness === 'unverified' ? 'unknown' : facts.freshness;
      if (facts.freshness !== 'current') { reasons.push('Pull-request source endpoints are not current'); break; }
      reasons.push(...facts.reasons.filter((reason) => reason !== 'pages_pending' || !page.continuation));
      for (const row of page.rows) {
        deliveredCount++;
        if (paths.has(row.path)) { reasons.push(`Duplicate pull-request path: ${row.path}`); continue; }
        paths.add(row.path); const file = projectRow(row); files.push(file);
        if (file.unavailableReason) reasons.push(`${file.path}: ${file.unavailableReason}`);
      }
      if (page.omittedRowCount || page.projectionTruncated) reasons.push('Pull-request source omitted comparison rows');
      if (facts.enumeratedFileCount !== deliveredCount) reasons.push('Pull-request source enumerated count does not match delivered rows');
      if (facts.failure) reasons.push('Pull-request source reported a transport failure');
      continuation = page.continuation;
      if (continuation) {
        if (continuations.has(continuation)) { reasons.push('Pull-request source repeated a continuation'); break; }
        continuations.add(continuation);
      } else {
        completed = facts.inventory === 'complete' && !page.incomplete && deliveredCount === totalFileCount;
        if (!completed) reasons.push('Pull-request source inventory is incomplete');
        if (facts.content !== 'complete') reasons.push('Pull-request source textual content is incomplete');
      }
    } while (continuation);
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : 'Pull-request source could not be read');
  }
  return { before, after, ...(pullRequest ? { pullRequest } : {}), files, reasons: [...new Set(reasons)], freshness,
    state: completed && !reasons.length ? 'complete' : files.length ? 'incomplete' : 'unavailable' };
}
