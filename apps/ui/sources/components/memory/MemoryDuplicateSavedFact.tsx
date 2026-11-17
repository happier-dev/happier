import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { DuplicateReview } from './MemoryDocumentBody';
import { MemoryFactDetailSections } from './MemoryFactDetail';
import { MemoryDocumentNotices } from './MemoryDocumentNotices';
import { useMemoryDocument } from './useMemoryDocument';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

/**
 * A duplicate review's look at one saved fact (C6 "Similar fact found"): the fact and its reason,
 * source, approval and history, read from the reviewed document through the ordinary memory read.
 * It sits in the same form, in place of the comparison; Back returns to the comparison with the draft
 * and the chosen effect untouched, since the form keeps them.
 */
export function MemoryDuplicateSavedFact(
  props: Readonly<{
    testID: string;
    review: DuplicateReview;
    factId: string;
    serverId: string;
    viewerAccountId: string | null;
    onBack: () => void;
    onOpenSession?: (
      ref: Readonly<{
        serverId: string;
        sessionId: string;
        messageId?: string;
      }>,
    ) => void;
    onOpenDiscussion?: (ref: DiscussionMessageRefV1) => void;
  }>,
) {
  const candidate =
    props.review.candidates.find((entry) => entry.factId === props.factId) ??
    null;
  const document = useMemoryDocument({
    ref: props.review.ref,
    serverId: props.serverId,
    ...(candidate?.topic ? { topic: candidate.topic } : {}),
  });
  const fact =
    document.view?.facts.find((entry) => entry.id === props.factId) ?? null;
  // The form owns its padding: the fact's sections read as on its own page (description above the
  // rows) and share the form's text edge with Back and the title instead of adding a second inset.
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
    <View testID={props.testID} style={styles.root}>
      <HappierPressable
        testID={`${props.testID}.back`}
        accessibilityRole="button"
        accessibilityLabel={t('memoryContext.memory.duplicateBack')}
        onPress={props.onBack}
        style={styles.back}
      >
        <Icon name="arrow-left" size={16} />
        <Text style={styles.backLabel}>
          {t('memoryContext.memory.duplicateBack')}
        </Text>
      </HappierPressable>
      {/* The saved words lead, as on the fact's own page; the reviewed text shows while it is read. */}
      <Text style={styles.title} accessibilityRole="header" selectable>
        {fact?.text ?? candidate?.text ?? ''}
      </Text>
      {fact ? (
        <MemoryFactDetailSections
          testID={props.testID}
          fact={fact}
          documentRef={props.review.ref}
          serverId={props.serverId}
          viewerAccountId={props.viewerAccountId}
          archived={false}
          onOpenSession={props.onOpenSession}
          onOpenDiscussion={props.onOpenDiscussion}
        />
      ) : document.status === 'loading' || document.status === 'refreshing' ? (
        <ItemLoadStateRows
          testID={`${props.testID}.loading`}
          state={{ kind: 'loading' }}
          rows={3}
          lines={1}
          accessibilityLabel={t('common.loading')}
        />
      ) : document.status === 'unavailable' ? (
        <MemoryDocumentNotices
          testID={props.testID}
          offline={false}
          since={null}
          source={document}
          notice={null}
        />
      ) : document.status === 'locked' || document.status === 'invalid' ? (
        <SurfaceStateCard
          testID={`${props.testID}.${document.status}`}
          size="line"
          kind="error"
          title={t(document.status === 'locked' ? 'memoryContext.memory.locked' : 'memoryContext.memory.invalid')}
        />
      ) : document.status === 'ready' || document.status === 'not_found' ? (
        // The fact changed or left since the review: say so; Back and saving still decide against the review.
        <SurfaceStateCard
          testID={`${props.testID}.missing`}
          size="line"
          kind="error"
          title={t('memoryContext.memory.duplicateSavedFactGone')}
        />
      ) : null}
    </View>
    </ListPresentationProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.space.s8,
  },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.space.s4,
  },
  backLabel: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  title: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
  },
}));
