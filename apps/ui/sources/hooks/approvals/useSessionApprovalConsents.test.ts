import { describe, expect, it } from 'vitest';
import { SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { projectArtifactInventoryIndex } from '@/sync/store/domains/artifactInventoryIndex';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { selectSessionApprovalConsentsArtifact } from './useSessionApprovalConsents';

const artifact = (
  id: string,
  header: Record<string, unknown>,
): DecryptedArtifact =>
  ({
    id,
    header: header as DecryptedArtifact['header'],
    rawHeader: header,
    title: null,
    headerVersion: 1,
    bodyVersion: 1,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    isDecrypted: true,
  }) as DecryptedArtifact;

describe('Session consent selection', () => {
  it("finds the Session's record through the Session index bucket, never its approval requests", () => {
    const rows = {
      approval: artifact('a-approval', {
        kind: APPROVAL_ARTIFACT_KINDS_V1.builtIn,
        sessionId: 's1',
        approvalStatus: 'open',
      }),
      later: artifact('z-consents', {
        kind: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
        sessionId: 's1',
      }),
      record: artifact('b-consents', {
        kind: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
        sessionId: 's1',
      }),
      other: artifact('c-consents', {
        kind: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
        sessionId: 's2',
      }),
    };
    const artifacts = Object.fromEntries(
      Object.values(rows).map((row) => [row.id, row]),
    );
    const artifactInventoryIndex = projectArtifactInventoryIndex(
      new Map(),
      {},
      artifacts,
      Object.keys(artifacts),
    );
    // The lowest id is the record every host reads and writes.
    expect(
      selectSessionApprovalConsentsArtifact(
        { artifacts, artifactInventoryIndex },
        's1',
      ),
    ).toBe(rows.record);
    expect(
      selectSessionApprovalConsentsArtifact(
        { artifacts, artifactInventoryIndex },
        's2',
      ),
    ).toBe(rows.other);
    expect(
      selectSessionApprovalConsentsArtifact(
        { artifacts, artifactInventoryIndex },
        's3',
      ),
    ).toBeUndefined();
  });
});
