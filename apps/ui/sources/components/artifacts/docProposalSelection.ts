import type { DocEditProposalV1, DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import { locateDocPassageV1, selectDocPassageThreadAnchorMessageV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import { isDiscussionDocEditProposalContentV1 } from '@happier-dev/protocol/discussions/content';

import { readDiscussionContentPassage } from '@/components/discussions/discussionComposerDocument';

type PassageMessage = Pick<DiscussionOpenedMessageV1, 'id' | 'seq' | 'content' | 'replyTarget'>;

/** Keep each immutable suggestion paired with the selection it answered, before later reattachments. */
export function docProposalSelections(messages: readonly PassageMessage[]): ReadonlyMap<string, DocPassageRefV1> {
  const selections = new Map<string, DocPassageRefV1>();
  let anchor: PassageMessage | null = null;
  for (const message of [...messages].sort((left, right) => left.seq - right.seq)) {
    anchor = selectDocPassageThreadAnchorMessageV1(anchor ? [anchor, message] : [message]);
    const passage = readDiscussionContentPassage(anchor?.content);
    if (passage && message.content && isDiscussionDocEditProposalContentV1(message.content)) selections.set(message.id, passage);
  }
  return selections;
}

export function readDocProposalSelection(messages: readonly PassageMessage[]): DocPassageRefV1 | undefined {
  return readDiscussionContentPassage(selectDocPassageThreadAnchorMessageV1(messages)?.content) ?? undefined;
}

/** Presentation only: compare untouched surroundings without rewriting the agent's replacement. */
export function docProposalChangesOutsideSelection(proposal: DocEditProposalV1, selection: DocPassageRefV1 | undefined): boolean {
  if (!selection) return false;
  const start = selection.range.start - proposal.target.range.start;
  const location = locateDocPassageV1({ source: proposal.before, revision: proposal.baseRevision,
    target: { ...selection, range: { start: Math.max(0, start), end: Math.max(0, start) + selection.quote.length },
      prefix: undefined, suffix: undefined } });
  if (location.state === 'detached') return false;
  const prefix = proposal.before.slice(0, location.range.start);
  const suffix = proposal.before.slice(location.range.end);
  return proposal.after.length < prefix.length + suffix.length
    || !proposal.after.startsWith(prefix) || !proposal.after.endsWith(suffix);
}
