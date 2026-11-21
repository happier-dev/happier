import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ReviewVerdictKindV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  SegmentedTabBar,
  type SegmentedTab,
} from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type ReviewSubmitResult = Readonly<
  { ok: true } | { ok: false; message: string }
>;

/**
 * Submit your review (lab `detail-submit`): the verdict for this round (Approve, Request changes,
 * Comment), an optional summary and one primary. The verdict belongs to the round it is given in; a new
 * round asks again. A failed send keeps the verdict and the summary.
 */
export function ReviewSubmitPanel(
  props: Readonly<{
    roundOrdinal: number;
    /** What goes with the verdict ("Your 2 decisions and 1 comment go with it"), from the findings owner. */
    caption?: string | null;
    initialVerdict?: ReviewVerdictKindV1;
    onSubmit: (
      input: Readonly<{
        verdict: ReviewVerdictKindV1;
        body: string | undefined;
      }>,
    ) => Promise<ReviewSubmitResult>;
    onCancel: () => void;
  }>,
): React.ReactElement {
  const [verdict, setVerdict] = React.useState<ReviewVerdictKindV1>(
    props.initialVerdict ?? 'approve',
  );
  const [body, setBody] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const tabs = React.useMemo(
    (): readonly SegmentedTab<ReviewVerdictKindV1>[] => [
      {
        id: 'approve',
        label: t('reviewWalkthrough.detail.approve'),
        testID: 'review-submit:verdict:approve',
      },
      {
        id: 'request_changes',
        label: t('reviewWalkthrough.detail.requestChanges'),
        testID: 'review-submit:verdict:request_changes',
      },
      {
        id: 'comment',
        label: t('reviewWalkthrough.detail.comment'),
        testID: 'review-submit:verdict:comment',
      },
    ],
    [],
  );
  const { onSubmit } = props;
  const submit = React.useCallback(async () => {
    setBusy(true);
    setFailure(null);
    const trimmed = body.trim();
    const result = await onSubmit({
      verdict,
      body: trimmed.length > 0 ? trimmed : undefined,
    });
    setBusy(false);
    if (!result.ok) setFailure(result.message);
  }, [body, onSubmit, verdict]);
  return (
    <ItemGroup
      testID="review-submit"
      title={t('reviewWalkthrough.detail.submitTitle')}
      titleAccessory={
        <Text variant="meta" style={styles.round}>
          {t('reviewWalkthrough.detail.round', { round: props.roundOrdinal })}
        </Text>
      }
    >
      <View style={styles.body}>
        <SegmentedTabBar<ReviewVerdictKindV1>
          role="radiogroup"
          tabs={tabs}
          activeTabId={verdict}
          onSelectTab={setVerdict}
          segmentSizing="content"
          testIDPrefix="review-submit:verdict"
          accessibilityLabel={t('reviewWalkthrough.detail.submitTitle')}
        />
        <FieldTextInput
          testID="review-submit:body"
          value={body}
          onChangeText={setBody}
          multiline
          minLines={2}
          growWithText
          placeholder={t('reviewWalkthrough.detail.summaryPlaceholder')}
          accessibilityLabel={t('reviewWalkthrough.detail.summaryPlaceholder')}
          error={failure}
        />
        <View style={styles.foot}>
          {props.caption ? (
            <Text variant="meta" style={styles.caption} numberOfLines={2}>
              {props.caption}
            </Text>
          ) : (
            <View style={styles.grow} />
          )}
          {/* The secondary beside the primary, as the dialog footers draw it: one height, one baseline. */}
          <RoundButton
            testID="review-submit:cancel"
            size="small"
            display="inverted"
            title={t('common.cancel')}
            disabled={busy}
            onPress={props.onCancel}
          />
          <RoundButton
            testID="review-submit:send"
            size="small"
            title={t('reviewWalkthrough.detail.submitReview')}
            loading={busy}
            disabled={busy}
            onPress={() => {
              void submit();
            }}
          />
        </View>
      </View>
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  round: { color: theme.colors.text.secondary },
  body: { padding: theme.space.s16, gap: theme.space.s12 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  caption: { flex: 1, color: theme.colors.text.secondary },
  grow: { flex: 1 },
}));
