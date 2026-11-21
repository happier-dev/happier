import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useSessionProviderUsageGauge } from '@/components/sessions/usage/useSessionProviderUsage';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import {
  WidgetFrame,
  type WidgetFrameStyle,
} from '@/components/widgets/frame/WidgetFrame';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { readSessionAgentLabel, useSessionContextUsageFacts } from '../summary/useSessionSummaryModel';

const stylesheet = StyleSheet.create((theme) => ({
  warning: { color: theme.colors.state.warning.textForeground },
  critical: { color: theme.colors.state.danger.textForeground },
}));

/**
 * The Usage section (lab crows B): the provider quota the composer's instrument shows for this Session
 * (one gauge owner, `useSessionProviderUsageGauge`), and how full the context is (the Session usage owner).
 * The quota row is absent only when there is no quota to read (a plain Account, no connected service): a failed
 * first read says the quota is unavailable, and a failed refresh keeps the last good value with its as-of. A
 * Session with neither fact has no Usage section. Recovery is the owner's (the next matching update or reopening).
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
  const { gauge, quotaReadFailed, quotaRefreshFailedAsOf } = useSessionProviderUsageGauge({
    session: props.session,
    serverId: props.serverId ?? props.session.serverId ?? '',
  });
  const usage = useSessionContextUsageFacts(props.session, props.serverId);
  const contextPercent = usage?.contextPercent ?? null;
  if (!gauge && !quotaReadFailed && contextPercent === null) return null;
  const glyph = (name: React.ComponentProps<typeof Icon>['name']) => (
    <Icon name={name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
  );
  return (
    <WidgetFrame
      testID={props.testID}
      presentation={props.presentation}
      frameStyle={props.frameStyle}
      placement="companion"
      mark="speedometer"
      title={t('sessionCompanion.sections.usage')}
      menu={props.menu}
      {...(quotaRefreshFailedAsOf !== null ? {
        meta: <SurfaceAsOfLabel at={quotaRefreshFailedAsOf} testID={`${props.testID}.asOf`} />,
        footer: { kind: 'refreshFailed' as const, reason: t('connectedServices.errors.quotaRefreshFailed') },
      } : {})}
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
                detail={t('common.unavailable')}
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
