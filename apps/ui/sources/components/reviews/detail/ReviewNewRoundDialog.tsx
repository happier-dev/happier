import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { useModalCardChrome } from '@/modal/components/card';
import type {
  CustomModalChromeCardConfig,
  CustomModalInjectedProps,
} from '@/modal/types';
import { t } from '@/text';

/** A reviewer of the round being repeated, with what happens to it in the new round (from the round owner). */
export type ReviewNewRoundReviewer = Readonly<{
  id: string;
  label: string;
  mark: React.ReactNode | null;
  continuity: 'continues' | 'fresh' | 'asked_again' | 'unavailable';
  required?: boolean;
}>;

export type ReviewNewRoundStart = () => Promise<
  Readonly<{ ok: true } | { ok: false; message: string }>
>;

type ReviewNewRoundDialogProps = CustomModalInjectedProps &
  Readonly<{
    previousRound: number;
    reviewers: readonly ReviewNewRoundReviewer[];
    onStart: ReviewNewRoundStart;
    ready?: boolean;
    loading?: boolean;
    reason?: string | null;
    onFresh?: () => void;
    onRetry?: () => void;
  }>;

function continuityLabel(reviewer: ReviewNewRoundReviewer): string {
  if (reviewer.continuity === 'unavailable') return t('common.unavailable');
  if (reviewer.continuity === 'continues')
    return t('reviewWalkthrough.detail.continuesSession');
  if (reviewer.continuity === 'fresh')
    return t('reviewWalkthrough.detail.startsFresh');
  return reviewer.required === false
    ? `${t('reviewWalkthrough.detail.askedAgain')} · ${t('reviewWalkthrough.detail.optional')}`
    : `${t('reviewWalkthrough.detail.askedAgain')} · ${t('reviewWalkthrough.detail.required')}`;
}

/**
 * New round (lab `detail-newround`): the same reviewers read the updated code inside this Review. Each
 * reviewer says in words whether it continues its session, starts fresh or is asked again; earlier verdicts
 * stay with their round, and the person decides what is fixed.
 */
export function ReviewNewRoundDialog(
  props: ReviewNewRoundDialogProps,
): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const { onStart, onClose } = props;
  const start = React.useCallback(async () => {
    setBusy(true);
    setFailure(null);
    const result = await onStart();
    setBusy(false);
    if (result.ok) onClose();
    else setFailure(result.message);
  }, [onClose, onStart]);
  const chrome = React.useMemo(
    (): CustomModalChromeCardConfig => ({
      kind: 'card',
      material: 'solid',
      title: t('reviewWalkthrough.detail.newRound'),
      subtitle: t('reviewWalkthrough.detail.newRoundDescription'),
      subtitleLines: 2,
      testID: 'review-new-round',
      scrollHost: 'bounded',
      dimensions: {
        width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide,
        maxHeightRatio: 0.86,
      },
      phonePresentation: 'sheet',
      footer: (
        <ModalCardFooterActions
          cancel={{
            onPress: onClose,
            testID: 'review-new-round:cancel',
            disabled: busy,
          }}
          note={failure ?? props.reason}
          noteTestID="review-new-round:failure"
        >
          <RoundButton
            testID="review-new-round:start"
            title={t('reviewWalkthrough.detail.startRound')}
            loading={busy}
            disabled={busy || props.ready === false}
            onPress={() => {
              void start();
            }}
          />
        </ModalCardFooterActions>
      ),
    }),
    [busy, failure, onClose, props.ready, props.reason, start],
  );
  useModalCardChrome(props.setChrome, chrome);
  return (
    <View style={styles.body}>
      {props.loading ? <SurfaceStateCard kind="loading" title={t('common.loading')} /> : null}
      <ItemGroup header="none" testID="review-new-round:reviewers">
        {props.reviewers.map((reviewer) => (
          <Item
            key={reviewer.id}
            testID={`review-new-round:reviewer:${reviewer.id}`}
            title={reviewer.label}
            icon={reviewer.mark ?? undefined}
            rightElement={
              <Text variant="meta" style={styles.continuity}>
                {continuityLabel(reviewer)}
              </Text>
            }
          />
        ))}
      </ItemGroup>
      {props.onFresh ? <TextLinkButton testID="review-new-round:fresh" label={t('reviewWalkthrough.detail.startsFresh')}
        onPress={() => { setFailure(null); props.onFresh?.(); }} /> : null}
      {props.onRetry ? <TextLinkButton testID="review-new-round:retry" label={t('common.retry')}
        onPress={props.onRetry} /> : null}
      <Text variant="body" style={styles.note}>
        {t('reviewWalkthrough.detail.newRoundNote', {
          round: props.previousRound,
        })}
      </Text>
    </View>
  );
}

export function showReviewNewRoundDialog(
  input: Readonly<{
    previousRound: number;
    reviewers: readonly ReviewNewRoundReviewer[];
    onStart: ReviewNewRoundStart;
  }>,
): void {
  Modal.show({ component: ReviewNewRoundDialog, props: input });
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s12, paddingBottom: theme.space.s8 },
  continuity: { color: theme.colors.text.secondary },
  note: {
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s16,
  },
}));
