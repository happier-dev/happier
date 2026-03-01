import type { ChatListItem } from '@/components/sessions/chatListItems';
import type { ForkedTranscriptSnapshot } from '@/sync/domains/sessionFork/forkedTranscriptSnapshot';

export function injectForkContextRows(params: Readonly<{
  baseItems: readonly ChatListItem[];
  fork: ForkedTranscriptSnapshot;
}>): ChatListItem[] {
  const boundaries: Array<{
    boundaryMessageIndex: number;
    parentSessionId: string;
    childSessionId: string;
    parentCutoffSeqInclusive: number;
  }> = [];

  let cumulative = 0;
  for (let i = 0; i < params.fork.segments.length - 1; i += 1) {
    const parent = params.fork.segments[i]!;
    const child = params.fork.segments[i + 1]!;
    cumulative += parent.messageIdsOldestFirst.length;
    boundaries.push({
      boundaryMessageIndex: cumulative,
      parentSessionId: parent.sessionId,
      childSessionId: child.sessionId,
      parentCutoffSeqInclusive: parent.cutoffSeqInclusive ?? 0,
    });
  }

  const output: ChatListItem[] = [];
  let messageCount = 0;
  let boundaryIndex = 0;

  const maybeInsertDividersAtBoundary = () => {
    while (true) {
      const boundary = boundaries[boundaryIndex];
      if (!boundary) return;
      if (messageCount !== boundary.boundaryMessageIndex) return;
      output.push({
        kind: 'fork-divider',
        id: `fork-divider:${boundary.parentSessionId}:${boundary.childSessionId}`,
        parentSessionId: boundary.parentSessionId,
        childSessionId: boundary.childSessionId,
        parentCutoffSeqInclusive: boundary.parentCutoffSeqInclusive,
      });
      boundaryIndex += 1;
    }
  };

  for (const item of params.baseItems) {
    maybeInsertDividersAtBoundary();
    if (item.kind === 'message') {
      const origin = params.fork.messageOriginById[item.messageId];
      if (origin) {
        output.push({
          ...item,
          originSessionId: origin.sessionId,
          isReadOnlyContext: origin.isReadOnlyContext,
        });
      } else {
        output.push(item);
      }
      messageCount += 1;
      continue;
    }
    output.push(item);
  }

  maybeInsertDividersAtBoundary();

  return output;
}
