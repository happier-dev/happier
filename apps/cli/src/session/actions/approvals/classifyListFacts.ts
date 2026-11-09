import { APPROVAL_ARTIFACT_KINDS_V1, type ApprovalArtifactStateV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { approvalArtifactBodyMatchesHeaderV1, deriveApprovalArtifactListFactsV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readApprovalPassFailure, type ApprovalPassFailure } from './passFailure';

type Header = Readonly<Record<string, unknown>>;

/** The Account Artifact store calls this classification uses (selection plus one CAS update per row). */
export type ApprovalListFactsClassificationStore = Readonly<{
  list(options: Readonly<{ kinds: readonly string[]; approvalStates: readonly ApprovalArtifactStateV1[]; includeBody: true; headerFilter(header: Header): boolean }>):
    Promise<Readonly<{ items: readonly Readonly<{ artifactId: string; header: Header; body?: unknown }>[]; coverage: 'complete' | 'partial' }>>;
  readForUpdate(artifactId: string): Promise<Readonly<{
    artifact: Readonly<{ header?: Header | null; body?: unknown }>;
    update(content: Readonly<{ header: Header; body: string }>): Promise<Readonly<{ ok: boolean }>>;
  }> | null>;
}>;

type Mismatch = Readonly<{ reason: 'body_unreadable' | 'header_disagrees'; actionId: string }>;
const SAFE_ACTION_ID = /^[A-Za-z0-9_.:-]{1,120}$/u;

function tally<T extends object>(entries: Map<string, T & { count: number }>, entry: T) {
  const key = JSON.stringify(entry);
  const current = entries.get(key) ?? { ...entry, count: 0 };
  current.count++;
  entries.set(key, current);
}

/** Why a stored body does not admit under its header: unreadable as a stored request, or contradicting the header. */
function readMismatch(header: Header, body: unknown): Mismatch {
  const actionId = typeof header.actionId === 'string' && SAFE_ACTION_ID.test(header.actionId) ? header.actionId : 'unknown';
  let value: unknown;
  try { value = typeof body === 'string' ? JSON.parse(body) : undefined; } catch { value = undefined; }
  return { reason: StoredApprovalRequestSchema.safeParse(value).success ? 'header_disagrees' : 'body_unreadable', actionId };
}

/**
 * One-time owner classification of open built-in approval headers written before `approvalListFacts`
 * existed (the list surfaces read them from headers). Facts come from the admitted body; a row whose
 * body does not agree with its header is left untouched and counted as mismatched by kind (reason and
 * Action id only). Write failures are counted separately by error class and code, never messages.
 * Classified headers leave the selection, so a later run reads nothing.
 */
export async function classifyOpenApprovalListFacts(input: Readonly<{ accountArtifactStore: ApprovalListFactsClassificationStore }>) {
  const selected = await input.accountArtifactStore.list({ kinds: [APPROVAL_ARTIFACT_KINDS_V1.builtIn], approvalStates: ['open'],
    includeBody: true, headerFilter: header => header.approvalListFacts === undefined });
  let classified = 0;
  const mismatches = new Map<string, Mismatch & { count: number }>();
  const failures = new Map<string, ApprovalPassFailure & { count: number }>();
  for (const listed of selected.items) {
    try {
      const current = await input.accountArtifactStore.readForUpdate(listed.artifactId);
      const header = current?.artifact.header;
      const body = current?.artifact.body;
      // Another writer may have rewritten it since the page; it then carries the facts itself.
      if (!current || !header || header.approvalListFacts !== undefined || header.approvalStatus !== 'open') continue;
      const parsed = typeof body === 'string' ? approvalArtifactBodyMatchesHeaderV1(header, body) : null;
      if (parsed?.family !== 'built_in' || typeof body !== 'string') { tally(mismatches, readMismatch(header, body)); continue; }
      const updated = await current.update({ header: { ...header, approvalListFacts: deriveApprovalArtifactListFactsV1(parsed.request) }, body });
      if (updated.ok) classified++; else tally(failures, { errorClass: 'ApprovalUpdateRefused' });
    } catch (error) { tally(failures, readApprovalPassFailure(error)); }
  }
  const count = (entries: Map<string, { count: number }>) => [...entries.values()].reduce((sum, entry) => sum + entry.count, 0);
  const mismatched = count(mismatches);
  const failed = count(failures);
  return { classified, mismatched, failed, coverage: selected.coverage,
    ...(mismatched ? { mismatches: [...mismatches.values()] } : {}),
    ...(failed ? { failures: [...failures.values()] } : {}) };
}
