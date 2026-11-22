import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useSessionProviderUsageGauge } from '@/components/sessions/usage/useSessionProviderUsage';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import {
  WidgetFrame,
  type WidgetFrameStyle,
} from '@/components/widgets/frame/WidgetFrame';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import { readSessionAgentLabel, useSessionContextUsageFacts } from '../summary/useSessionSummaryModel';

const stylesheet = StyleSheet.create((theme) => ({
  warning: { color: theme.colors.state.warning.textForeground },
  critical: { color: theme.colors.state.danger.textForeground },
}));

/**
 * The Usage section (lab crows B): the provider quota the composer's instrument shows for this Session
 * (one gauge owner, `useSessionProviderUsageGauge`), and how full the context is (the Session usage owner).
 * The quota row is absent only when there is no quota to read (a plain Account, no connected service): a failed
 * first read says usage could not be read (the composer ring's words), and a failed refresh keeps the last good
 * value with the failure and its as-of in the row's own caption. Retry is the owner's next read, where it has one.
 * A Session with neither fact has no Usage section.
 */
export function UsageGlance(
  props: Readonly<{
    session: Session;
    sessionId: string;
    serverId: string | null;
    frameStyle: WidgetFrameStyle;
    presentation?: 'frame' | 'body';
    menu?: React.ReactNode;
    measurementOnly: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { gauge, quotaReadFailed, quotaRefreshFailedAsOf, retryQuotaRead } = useSessionProviderUsageGauge({
    session: props.session,
    serverId: props.serverId ?? props.session.serverId ?? '',
  });
  const usage = useSessionContextUsageFacts(props.session, props.serverId);
  const contextPercent = usage?.contextPercent ?? null;
  if (!gauge && !quotaReadFailed && contextPercent === null) return null;
  const glyph = (name: React.ComponentProps<typeof Icon>['name']) => (
    <Icon name={name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
  );
  const retry = retryQuotaRead
    ? <TextLinkButton label={t('common.retry')} size="meta" onPress={retryQuotaRead} testID={`${props.testID}.quota.retry`} />
    : undefined;
  return (
    <WidgetFrame
      testID={props.testID}
      presentation={props.presentation}
      frameStyle={props.frameStyle}
      placement="companion"
      mark="speedometer"
      title={t('sessionCompanion.sections.usage')}
      menu={props.menu}
      body={{
        kind: 'content',
        children: (
          <>
            {gauge ? (
              <Item
                testID={`${props.testID}.quota`}
                density="compact"
                mode="info"
                icon={glyph('speedometer')}
                title={gauge.providerDisplayName ?? readSessionAgentLabel(props.session) ?? gauge.badgeLabel}
                titleQualifier={gauge.scopePrefix}
                {...(quotaRefreshFailedAsOf !== null ? {
                  subtitle: `${t('connectedServices.errors.quotaRefreshFailed')} · ${t('settingsOverview.asOf', { time: formatAsOfTime(quotaRefreshFailedAsOf) })}`,
                  subtitleTestID: `${props.testID}.quota.reason`,
                  subtitleAccessory: retry,
                } : {})}
                detail={
                  gauge.resetLabel && gauge.tone !== 'neutral'
                    ? `${gauge.valueLabel} · ${gauge.resetLabel}`
                    : gauge.valueLabel
                }
                {...(gauge.tone === 'neutral'
                  ? {}
                  : {
                      detailStyle:
                        gauge.tone === 'critical'
                          ? stylesheet.critical
                          : stylesheet.warning,
                    })}
              />
            ) : quotaReadFailed ? (
              <Item
                testID={`${props.testID}.quota`}
                density="compact"
                mode="info"
                icon={glyph('speedometer')}
                title={readSessionAgentLabel(props.session) ?? t('sessionCompanion.sections.usage')}
                subtitle={t('usage.board.page.readFailedTitle')}
                subtitleTestID={`${props.testID}.quota.reason`}
                subtitleAccessory={retry}
              />
            ) : null}
            {contextPercent !== null ? (
              <Item
                testID={`${props.testID}.context`}
                density="compact"
                mode="info"
                icon={glyph('chart-pie')}
                title={t('sessionCompanion.sections.context')}
                detail={t('sessionCompanion.facts.contextValue', {
                  percent: Math.round(contextPercent),
                })}
              />
            ) : null}
          </>
        ),
      }}
    />
  );
}
