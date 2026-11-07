import { APPROVAL_ARTIFACT_KINDS_V1, type ApprovalArtifactStateV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { approvalArtifactBodyMatchesHeaderV1, deriveApprovalArtifactListFactsV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

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

/**
 * One-time owner classification of open built-in approval headers written before `approvalListFacts`
 * existed (the list surfaces read them from headers). Facts come from the admitted body; a row whose
 * body does not agree with its header is left untouched and counted as failed. Classified headers
 * leave the selection, so a later run reads nothing.
 */
export async function classifyOpenApprovalListFacts(input: Readonly<{ accountArtifactStore: ApprovalListFactsClassificationStore }>) {
  const selected = await input.accountArtifactStore.list({ kinds: [APPROVAL_ARTIFACT_KINDS_V1.builtIn], approvalStates: ['open'],
    includeBody: true, headerFilter: header => header.approvalListFacts === undefined });
  let classified = 0;
  let failed = 0;
  for (const listed of selected.items) {
    try {
      const current = await input.accountArtifactStore.readForUpdate(listed.artifactId);
      const header = current?.artifact.header;
      const body = current?.artifact.body;
      // Another writer may have rewritten it since the page; it then carries the facts itself.
      if (!current || !header || header.approvalListFacts !== undefined || header.approvalStatus !== 'open') continue;
      const parsed = typeof body === 'string' ? approvalArtifactBodyMatchesHeaderV1(header, body) : null;
      if (parsed?.family !== 'built_in' || typeof body !== 'string') { failed++; continue; }
      const updated = await current.update({ header: { ...header, approvalListFacts: deriveApprovalArtifactListFactsV1(parsed.request) }, body });
      if (updated.ok) classified++; else failed++;
    } catch { failed++; }
  }
  return { classified, failed, coverage: selected.coverage };
}
