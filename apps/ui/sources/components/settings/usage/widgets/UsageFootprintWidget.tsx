import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierBadge, HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';

/**
 * Footprint lens: an energy/emissions estimate exists only when a versioned published method applies
 * to the admitted model, serving, date and region facts. Until then it says so plainly, shows what was
 * accounted (tokens are a proxy, never a measurement) and never draws a number for kWh or CO₂e.
 */
export function UsageFootprintWidget(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const footprint = props.slice.howYouWork?.footprint ?? null;
  useWidgetFrameBodyCaption(footprint ? usagePeriodPhrase(props.query) : null);
  if (!footprint) {
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.howYouWork.footprintNoUsageTitle')}
        reason={t('usage.board.howYouWork.footprintNoUsageReason')}
      />
    );
  }
  const tokens = footprint.coverage.accountedTokens.total;
  return (
    <View style={styles.body} testID={`${props.testID}.footprint`}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title} testID={`${props.testID}.status`}>
            {t('usage.board.howYouWork.footprintInsufficientTitle')}
          </Text>
          <Text style={styles.reason}>
            {t('usage.board.howYouWork.footprintInsufficientReason')}
          </Text>
        </View>
        <HappierBadge color={theme.colors.text.secondary} backgroundColor={theme.colors.surface.inset}>
          {t('usage.board.howYouWork.footprintNoEstimate')}
        </HappierBadge>
      </View>
      <HappierDataMetric
        theme={chartTheme}
        testID={`${props.testID}.tokens`}
        label={t('usage.board.howYouWork.footprintAccounted')}
        value={formatTokenCount(tokens)}
        unit={t('usage.tokens').toLocaleLowerCase()}
        comparison={{
          value: t('usage.board.howYouWork.footprintProxy'),
          label: t('usage.board.howYouWork.footprintProxyDetail'),
          meaning: 'neutral',
        }}
      />
      <View style={styles.method}>
        <Text style={styles.methodTitle}>
          {t('usage.board.howYouWork.footprintMethodTitle')}
        </Text>
        <Text style={styles.reason}>
          {t('usage.board.howYouWork.footprintMethodBody')}
        </Text>
      </View>
      <UsageCoverageLine
        testID={`${props.testID}.coverage`}
        slice={props.slice}
        sources={['accounting']}
        onRetry={props.model.refresh}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 18, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headText: { flex: 1, minWidth: 0, gap: 4 },
  title: {
    ...Typography.default('semiBold'),
    fontSize: 15,
    lineHeight: 20,
    color: theme.colors.text.primary,
  },
  reason: {
    ...Typography.default(),
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.text.secondary,
  },
  method: { gap: 4 },
  methodTitle: {
    ...Typography.default('semiBold'),
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.text.primary,
  },
}));
