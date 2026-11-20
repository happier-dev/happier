import { decodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { isPresentUserAuthTokenKind } from '@/app/api/utils/requirePresentUser';
import type { Tx } from '@/storage/inTx';
import { markAccountChanged } from "@/app/changes/markAccountChanged";

export function isSessionApprovalConsentsStoredKind(
  kind: string | null | undefined,
): boolean {
  return (
    typeof kind === 'string' &&
    decodeArtifactKindV1(kind).kindHint ===
      SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1
  );
}

/**
 * The one writer rule for a Session's "allow for this Session" record, applied inside the
 * Artifact write owner whenever the current or next stored kind is the consent kind: create,
 * re-kind, re-bind, header and body writes alike (design F-3). The writer is a person-class
 * credential, the same rule as the Account rung (`requirePresentUser`, F-7), and the record binds
 * only to a Session the writer's Account owns. Signed token provenance and the Session row
 * decide it; nothing the client asserts does.
 */
export async function admitSessionApprovalConsentWriteInTx(
  tx: Tx,
  input: Readonly<{
    actorAccountId: string;
    ownerAccountId: string;
    writerAuthTokenKind: unknown;
    current: Readonly<{
      kind: string | null;
      approvalSessionId: string | null;
    }> | null;
    next: Readonly<{ kind: string | null; approvalSessionId: string | null }>;
  }>,
): Promise<boolean> {
  const currentIsConsent = isSessionApprovalConsentsStoredKind(
    input.current?.kind,
  );
  const nextIsConsent = isSessionApprovalConsentsStoredKind(input.next.kind);
  if (!currentIsConsent && !nextIsConsent) return true;
  if (
    !isPresentUserAuthTokenKind(input.writerAuthTokenKind) ||
    input.actorAccountId !== input.ownerAccountId
  )
    return false;
  if (!nextIsConsent) return true;
  const sessionId = input.next.approvalSessionId;
  if (!sessionId) return false;
  // Ownership was admitted when this exact binding was written.
  if (currentIsConsent && input.current?.approvalSessionId === sessionId)
    return true;
  const session = await tx.session.findFirst({
    where: { id: sessionId, accountId: input.actorAccountId },
    select: { id: true },
  });
  return session !== null;
}

/**
 * Session deletion ends its consent record. The record is private (no grants or links) and has
 * a text body only, so the owner's own Artifact change is the whole publication.
 */
export async function deleteSessionApprovalConsentsInTx(tx: Tx, input: Readonly<{ sessionId: string }>): Promise<void> {
    // Only the Session's owner can have bound a record to it; read through the owner's index.
    const session = await tx.session.findUnique({ where: { id: input.sessionId }, select: { accountId: true } });
    if (!session) return;
    const records = await tx.artifact.findMany({
        where: { accountId: session.accountId, approvalSessionId: input.sessionId,
            kind: { endsWith: `:${SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1}` } },
        select: { id: true, accountId: true, kind: true },
    });
    for (const record of records) {
        if (!isSessionApprovalConsentsStoredKind(record.kind)) continue;
        await markAccountChanged(tx, { accountId: record.accountId, kind: "artifact", entityId: record.id });
        await tx.artifact.deleteMany({ where: { id: record.id, accountId: record.accountId } });
    }
}
