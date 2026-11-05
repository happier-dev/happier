import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_STATE_LINE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** One catalog that didn't answer: its words (name · reason, already translated) and the read that retries it. */
export type RegistrySourceFailure = Readonly<{
  key: string;
  message: string;
  /** The same words apart, for a page whose one failure is its state: the catalog as the title, its reason beneath. */
  source?: string;
  reason?: string;
  /** Technical facts for support, shown only when asked for. */
  details?: readonly string[];
  onRetry: () => void | Promise<void>;
}>;

/**
 * The one quiet outage line for the catalogs a page reads (Store pages, registry shelves). One source names
 * itself on the line; several are said once ("5 sources couldn't be reached") with one Try again that re-reads
 * each distinct read once, and their names wait behind Details (LV-JUDGE-1102 UI-FIX-D). Unreachable catalogs
 * don't need the person, so the line stays in the quiet unavailable ink rather than amber.
 */
export function RegistrySourcesUnavailable(
  props: Readonly<{
    failures: readonly RegistrySourceFailure[];
    testID: string;
    /** `page`: nothing else on the page is held, so the failure is its state rather than a line under results. */
    size?: 'line' | 'page';
  }>,
): React.ReactNode {
  const [open, setOpen] = React.useState(false);
  const { failures } = props;
  if (failures.length === 0) return null;
  const retry = () => {
    for (const onRetry of new Set(failures.map((failure) => failure.onRetry))) {
      fireAndForget(Promise.resolve(onRetry()), {
        tag: 'RegistrySourcesUnavailable.retry',
      });
    }
  };
  const single = failures.length === 1 ? failures[0]! : null;
  const pageState = props.size === 'page' && single?.source && single.reason ? single : null;
  const details = failures.flatMap((failure) => failure.details ?? []);
  const revealable = !single || details.length > 0;
  return (
    <View>
      <SurfaceStateCard
        testID={props.testID}
        kind="unavailable"
        size={props.size ?? 'line'}
        title={
          pageState?.source ?? (single
            ? single.message
            : t('capabilities.store.sourcesUnreachable', {
                count: failures.length,
              }))
        }
        {...(pageState?.reason ? { reason: pageState.reason } : {})}
        action={{
          label: t('capabilities.store.retry'),
          onPress: retry,
          testID: `${props.testID}.retry`,
        }}
        {...(!revealable
          ? {}
          : {
              secondaryAction: {
                label: open
                  ? t('capabilities.store.hideSources')
                  : t('common.details'),
                onPress: () => setOpen((value) => !value),
                testID: `${props.testID}.details`,
              },
            })}
      />
      {revealable && open ? (
        <View style={styles.details} testID={`${props.testID}.sources`}>
          {(single ? [] : failures.map((failure) => failure.message)).concat(details).map((line, index) => (
            <Text key={index} variant="meta" style={styles.detail}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // On the line's text edge, under its sentence.
  details: {
    gap: theme.space.s4,
    paddingLeft:
      HAPPIER_STATE_LINE_METRICS.paddingHorizontalPx +
      HAPPIER_STATE_LINE_METRICS.glyphPx +
      HAPPIER_STATE_LINE_METRICS.gapPx,
    paddingRight: HAPPIER_STATE_LINE_METRICS.paddingHorizontalPx,
    paddingBottom: theme.space.s8,
  },
  detail: { color: theme.colors.text.secondary },
}));
