import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { formatHappierDataValue, UsageFootprintBody } from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { getPreferredLanguage, t } from '@/text';
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
  const accountedTokens = formatTokenCount(tokens);
  const exact = formatHappierDataValue(tokens, getPreferredLanguage());
  return (
    <UsageFootprintBody theme={chartTheme} testID={props.testID} accountedTokens={accountedTokens}
      accountedTokensDatum={accountedTokens.includes(exact) ? undefined : { label: t('usage.board.howYouWork.footprintAccounted'),
        value: `${exact} ${t('usage.tokens').toLocaleLowerCase()}`, subtitle: t('usage.board.howYouWork.footprintProxyDetail') }}
      spacing={{ head: theme.space.s12, detail: theme.space.s4 }}
      badgeColor={theme.colors.text.secondary} badgeBackgroundColor={theme.colors.surface.inset}
      textStyles={{ title: styles.title, reason: styles.reason, methodTitle: styles.methodTitle }}
      labels={{
        title: t('usage.board.howYouWork.footprintInsufficientTitle'),
        reason: t('usage.board.howYouWork.footprintInsufficientReason'),
        noEstimate: t('usage.board.howYouWork.footprintNoEstimate'),
        accounted: t('usage.board.howYouWork.footprintAccounted'),
        tokensUnit: t('usage.tokens').toLocaleLowerCase(),
        proxy: t('usage.board.howYouWork.footprintProxy'),
        proxyDetail: t('usage.board.howYouWork.footprintProxyDetail'),
        methodTitle: t('usage.board.howYouWork.footprintMethodTitle'),
        methodBody: t('usage.board.howYouWork.footprintMethodBody'),
      }} coverage={<UsageCoverageLine
        testID={`${props.testID}.coverage`}
        slice={props.slice}
        sources={['accounting']}
        onRetry={props.model.refresh}
      />} />
  );
}

const styles = StyleSheet.create((theme) => ({
  title: {
    ...Typography.variant('heading'),
    color: theme.colors.text.primary,
  },
  reason: {
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
  },
  methodTitle: {
    ...Typography.variant('body', 'semiBold'),
    color: theme.colors.text.primary,
  },
}));
