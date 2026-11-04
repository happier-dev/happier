import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useApprovalReview, type ApprovalReviewInput } from './useApprovalReview';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface.base,
  },
  page: {
    flex: 1,
    minHeight: 0,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.space.s24,
  },
  recoveryActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: theme.space.s12,
    marginTop: theme.space.s12,
  },
}));

/** The Inbox's approval page: the shared review (`useApprovalReview`) in page chrome. */
export const ApprovalDetailScreen = React.memo((props: ApprovalReviewInput) => {
  const { theme } = useUnistyles();
  const review = useApprovalReview(props);

  if (review.kind === 'loading') {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <ActivitySpinner size="large" color={theme.colors.text.secondary} />
        </View>
      </View>
    );
  }

  if (review.kind === 'locked') {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <Text style={{ color: theme.colors.text.secondary }}>{review.message}</Text>
          <View style={{ height: 12 }} />
          <RoundButton
            size="normal"
            display="secondary"
            title={t('common.back')}
            onPress={() => review.goBack()}
          />
        </View>
      </View>
    );
  }

  if (review.kind === 'error') {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <Text style={{ color: theme.colors.text.secondary }}>{review.message}</Text>
          <View style={styles.recoveryActions}>
            {review.retry ? (
              <RoundButton
                testID="approvals.retry"
                size="normal"
                title={t('common.retry')}
                accessibilityLabel={t('common.retry')}
                onPress={review.retry}
              />
            ) : null}
            <RoundButton
              size="normal"
              display="secondary"
              title={t('common.back')}
              accessibilityLabel={t('common.back')}
              onPress={() => review.goBack()}
            />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.page}>
    <ItemList>
      <PageHeader
        testID="approvals.header"
        alwaysShowTitle
        title={review.title}
        description={review.description}
        meta={review.headerFacts.length > 0 ? review.headerFacts : undefined}
      />

      {review.requestGroup}
      {review.sections}
      {review.workspaceSyncReview}
      {/* Who asked follows what they asked for: the thing being decided leads the page. */}
      {review.requesterContext}
      {review.requesterConfirmationSection}
      {review.confidential}
      {review.decision}
    </ItemList>
    </View>
  );
});

ApprovalDetailScreen.displayName = 'ApprovalDetailScreen';
