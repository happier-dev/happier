import { deriveApprovalArtifactQueryHintsV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { ACCOUNT_NOTICE_ARTIFACT_KIND_V1, USAGE_NOTICE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { DecryptedArtifact } from '../../domains/artifacts/artifactTypes';
import { doesArtifactInventorySelectionMatchHeader, isApprovalSessionInventorySelection,
  isApprovalStateInventorySelection, readArtifactBrowserMembership,
  type ArtifactInventorySelection } from '../../domains/artifacts/artifactInventory';

/** Header-query membership, not body admission or authority. Only Artifact ingress writes it. */
export type ArtifactInventoryIndex = ReadonlyMap<string, ReadonlySet<string>>;

const key = (dimension: 'kind' | 'state' | 'session', value: string) => JSON.stringify([dimension, value]);
const browserKey = 'browser';

function memberships(artifact: DecryptedArtifact | undefined): readonly string[] {
  if (!artifact) return [];
  const header = artifact.rawHeader ?? artifact.header;
  const keys: string[] = [];
  if (header) {
    if (typeof header.kind === 'string') keys.push(key('kind', header.kind));
    const hints = deriveApprovalArtifactQueryHintsV1(header);
    if (hints.approvalState !== null) keys.push(key('state', hints.approvalState));
    if (hints.approvalSessionId !== null) keys.push(key('session', hints.approvalSessionId));
  }
  if (readArtifactBrowserMembership(artifact) === true) keys.push(browserKey);
  return keys;
}

/** Patch only changed identities, preserving every unaffected query bucket. */
export function projectArtifactInventoryIndex(index: ArtifactInventoryIndex,
  before: Readonly<Record<string, DecryptedArtifact>>, after: Readonly<Record<string, DecryptedArtifact>>,
  changedIds: Iterable<string>): ArtifactInventoryIndex {
  let next = index;
  for (const id of changedIds) {
    const previous = memberships(before[id]);
    const current = memberships(after[id]);
    for (const membership of new Set([...previous, ...current])) {
      const present = current.includes(membership);
      const bucket = next.get(membership);
      if ((bucket?.has(id) ?? false) === present) continue;
      if (next === index) next = new Map(index);
      const ids = !bucket || bucket === index.get(membership) ? new Set(bucket) : bucket as Set<string>;
      if (present) ids.add(id); else ids.delete(id);
      if (ids.size === 0) (next as Map<string, ReadonlySet<string>>).delete(membership);
      else (next as Map<string, ReadonlySet<string>>).set(membership, ids);
    }
  }
  return next;
}

/** A selected census reconciles only that query's admitted members, never Account history. */
export function selectArtifactInventoryRows(state: Readonly<{
  artifacts: Readonly<Record<string, DecryptedArtifact>>;
  artifactInventoryIndex: ArtifactInventoryIndex;
}>, selection?: ArtifactInventorySelection): Readonly<Record<string, DecryptedArtifact>> {
  if (selection === undefined) return state.artifacts;
  const keys = selection === 'browserListed' ? [browserKey]
    : selection === 'inboxOpen' ? [key('state', 'open'), key('kind', ACCOUNT_NOTICE_ARTIFACT_KIND_V1), key('kind', USAGE_NOTICE_ARTIFACT_KIND_V1)]
    : isApprovalSessionInventorySelection(selection) ? selection.approvalSessionIds.map(id => key('session', id))
    : isApprovalStateInventorySelection(selection) ? selection.approvalStates.map(state => key('state', state))
    : selection.map(kind => key('kind', kind));
  const selected: Record<string, DecryptedArtifact> = {};
  for (const membership of keys) for (const id of state.artifactInventoryIndex.get(membership) ?? []) {
    if (Object.hasOwn(selected, id)) continue;
    const artifact = state.artifacts[id];
    if (!artifact) continue;
    if (selection === 'browserListed'
      || doesArtifactInventorySelectionMatchHeader(selection, artifact.rawHeader ?? artifact.header ?? {})) selected[id] = artifact;
  }
  return selected;
}
