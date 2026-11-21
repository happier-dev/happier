import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { ReviewFindingLine } from '@/components/sessions/reviews/findings/ReviewSeverity';

import { buildReviewCommentLabels } from './sessionSurfaceLabels';

/**
 * A page that opens its own findings (a Review) lends this to the code it hosts: a finding under its line
 * is then one line that opens it there (lab `detail-changes`), not a second copy of the finding's body.
 */
export const ReviewFindingAnchorContext = React.createContext<
  ((commentId: string) => void) | null
>(null);

/** One finding under the line it is about: severity, title and who found it, opening the finding. */
export function ReviewFindingAnchor(
  props: Readonly<{
    comment: ReviewCommentV1;
    onOpen: (commentId: string) => void;
  }>,
) {
  const finding = props.comment.finding;
  if (!finding) return null;
  const engine =
    props.comment.engineId ??
    (props.comment.author.kind === 'agent'
      ? props.comment.author.agentId
      : null);
  // A settled finding says so beside who found it; an open one needs no word.
  const settled = props.comment.state === 'resolved' || props.comment.state === 'dismissed';
  return (
    <View style={styles.anchor}>
      <ReviewFindingLine
        testID={`review-finding-anchor:${props.comment.id}`}
        severity={props.comment.findingSeverity ?? finding.severity}
        title={finding.title}
        reviewer={[settled ? buildReviewCommentLabels().states[props.comment.state] : null,
          engine ? resolveAgentCatalogTitle(engine) : null].filter(Boolean).join(' · ')}
        onPress={() => props.onOpen(props.comment.id)}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Beside the code it is about, on the code's own inset, framed like the comment drafts that sit there.
  anchor: {
    marginVertical: theme.space.s6,
    marginHorizontal: theme.space.s12,
    paddingHorizontal: theme.space.s8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface.base,
  },
}));
