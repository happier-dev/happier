import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';

import { DiscussionInlineCreateComposer } from '@/components/discussions/DiscussionInlineCreateComposer';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

/** A comment being started on a passage: its private `newDiscussion` draft and the passage it is about. */
export type DocNewPassageComment = Readonly<{
  draftId: string;
  passage: DocPassageRefV1;
}>;

/**
 * A new thread in the Doc's margin, beside the selection it comments on (lab K1-S): the passage's quote
 * and the one Discussion composer on the draft Comment wrote. Send creates the anchored Discussion through
 * the same create path as the new-Discussion page; nothing is sent before Send, and an unaddressed comment
 * starts no agent turn. An outcome that needs the person (refused, not known yet, waiting for approval)
 * is handled on that page, which "Open discussion" leads to with the same draft.
 */
export function ArtifactNewPassageThread(
  props: Readonly<{
    scope: ServerAccountScope;
    comment: DocNewPassageComment;
    onCreated: (discussion: DiscussionOpenedSummaryV1) => void;
    onOpenDiscussion: () => void;
    onClose: () => void;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const serverIds = React.useMemo(
    () => [props.scope.serverId],
    [props.scope.serverId],
  );
  const bindings = useServerCredentialAccountScopeBindings(serverIds);
  const binding = [...bindings.values()][0] ?? null;
  const testID = `artifact:passage-new:${props.comment.draftId}`;
  return (
    // The composer's own card is the thread's one frame; the passage it is about sits above it.
    <View testID={testID} style={styles.card}>
      <View style={styles.quoteRow}>
        <Icon
          name="quotes"
          size={ICON_SIZE.xs}
          color={theme.colors.text.tertiary}
        />
        <Text variant="meta" numberOfLines={1} style={styles.quote}>
          {props.comment.passage.quote}
        </Text>
        <IconButton
          testID={`${testID}.close`}
          iconName="x"
          size={24}
          accessibilityLabel={t('common.cancel')}
          onPress={props.onClose}
        />
      </View>
      {binding ? (
        <DiscussionInlineCreateComposer
          key={JSON.stringify([
            binding.scope.serverId,
            binding.scope.accountId,
            props.comment.draftId,
          ])}
          testID={testID}
          binding={binding}
          draftId={props.comment.draftId}
          focusOnOpen
          onCreated={props.onCreated}
          onOpenDiscussion={props.onOpenDiscussion}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { gap: theme.space.s8 },
  quoteRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, paddingLeft: theme.space.s12 },
  quote: { flex: 1, minWidth: 0, color: theme.colors.text.tertiary },
}));
