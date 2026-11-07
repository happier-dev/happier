import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { approvalArtifactBodyMatchesHeaderV1, buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createApprovalRequestArtifact } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';

type ArtifactStore = Pick<ReturnType<typeof createAccountArtifactStore>, 'read' | 'readForUpdate' | 'create' | 'list'>;

function readTargetActionApprovalArtifact(header: Readonly<Record<string, unknown>>, body: unknown): TargetActionApprovalRequestV1 | null {
  if (typeof body !== 'string') return null;
  const parsed = approvalArtifactBodyMatchesHeaderV1(header, body);
  return parsed?.family === 'target_action' ? parsed.request : null;
}

/** Target approvals share one creation, read, transition and settlement owner. */
export function createTargetActionApprovalLifecycle(input: Readonly<{
  accountArtifactStore: ArtifactStore;
  getAccountId(): string | null;
  newId(): string;
  prepareRequesterRecipient(artifactId: string, subject: TargetActionApprovalRequestV1['requesterConfirmation']): Promise<void>;
}>) {
  const { accountArtifactStore } = input;
  const targetActionApprovalsUpdate = async ({ artifactId, request }: Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>) => {
    const current = await accountArtifactStore.readForUpdate(artifactId);
    if (!current) return { ok: false as const, errorCode: 'not_found', error: 'artifact_not_found' };
    const existing = readTargetActionApprovalArtifact(current.artifact.header, current.artifact.body);
    if (!existing) return { ok: false as const, errorCode: 'subject_mismatch', error: 'target_action_approval_subject_mismatch' };
    const transition = admitTargetActionApprovalTransition(existing, request);
    if (!transition.ok) return transition;
    if (transition.unchanged) return { ok: true as const };
    const updated = await current.update({ header: buildTargetActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) });
    return updated.ok ? { ok: true as const } : updated;
  };
  return {
    targetActionApprovalsCreate: async ({ request, onReady }: Readonly<{ request: TargetActionApprovalRequestV1;
      onReady?: (created: Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>) => void }>) => {
      let ready = false;
      const res = await createApprovalRequestArtifact({ request, accountId: input.getAccountId(), newId: input.newId,
        read: artifactId => accountArtifactStore.read(artifactId, { ownerOnly: true, prepareRecipients: false }),
        create: async (artifactId, header, body, idScope) => {
          onReady?.({ artifactId, request });
          ready = true;
          await accountArtifactStore.create({ artifactId, header, body, idScope });
        } });
      if (!ready) onReady?.(res);
      await input.prepareRequesterRecipient(res.artifactId, request.requesterConfirmation);
      return res;
    },
    targetActionApprovalsGet: async ({ artifactId }: Readonly<{ artifactId: string }>) => {
      const artifact = await accountArtifactStore.read(artifactId, { prepareRecipients: false });
      return artifact ? readTargetActionApprovalArtifact(artifact.header, artifact.body) : null;
    },
    targetActionApprovalsUpdate,
  };
}
