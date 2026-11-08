import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { t } from '@/text';
import { ConnectedAccountActionApprovalNotice } from '../ConnectedAccountActionApprovalNotice';

import type { PoolGatewayChoice } from './poolGatewayChoices';
import type { usePoolGatewayChoices } from './usePoolGatewayChoices';
import { joinList } from '@/utils/text/joinList';

export type PoolGatewaySectionProps = Readonly<{
  testID: string;
  usage: ReturnType<typeof usePoolGatewayChoices>;
  poolTitle: string;
  serviceLabel: string;
  /** The agents that sign in to this pool directly, by name; empty when not known. */
  nativeAgentTitles: readonly string[];
  /** Names the account or pool a gateway draws on today, for the replacement question. */
  presentTarget?: (
    target: QualifiedConnectedAccountPurposeBindingTargetV1,
  ) => string;
  onOpenGateway?: (choice: PoolGatewayChoice) => void;
  onOpenGatewayDraft?: (route: string) => void;
}>;

/**
 * "Use in other agents" on a pool (lab `rgateway` PL1/PL2): one switch per gateway that can draw on
 * this pool's vendor. On, it shows what changes between the pool's own sign-in and the gateway, and
 * leads to the gateway. Replacing another account or pool uses the gateway Action's approval policy.
 *
 * It writes nothing itself; the gateway's slot is the one owner, through `usage.setEnabled`.
 */
export const PoolGatewaySection = React.memo(function PoolGatewaySection(
  props: PoolGatewaySectionProps,
) {
  const { theme } = useUnistyles();
  const { usage } = props;
  const setEnabled = usage.setEnabled;
  const write = React.useCallback(
    (connectionId: string, enabled: boolean) => {
      // A refusal is reported by the mutation owner and shown below; the switch reads saved state.
      void setEnabled(connectionId, enabled).catch(() => undefined);
    },
    [setEnabled],
  );

  const first = React.useCallback(() => {
    const route = usage.gatewayDraftRoute();
    if (route) props.onOpenGatewayDraft?.(route);
  }, [props.onOpenGatewayDraft, usage.gatewayDraftRoute]);

  // A failed write keeps its recovery on screen even when the choice list has gone empty meanwhile.
  if (usage.choices.length === 0 && !usage.firstGateway && !usage.error) return null;
  const firstGatewayTitle = t('settingsProvidersCollection.gateway.mainGatewayName');

  const native = joinList(props.nativeAgentTitles);

  return (
    <ItemGroup
      title={t('settingsProvidersCollection.gateway.poolSectionTitle')}
      description={
        native
          ? t('settingsProvidersCollection.gateway.poolSectionDescription', {
              agents: native,
              count: props.nativeAgentTitles.length,
            })
          : t(
              'settingsProvidersCollection.gateway.poolSectionDescriptionGeneric',
            )
      }
    >
      <ConnectedAccountActionApprovalNotice pendingApproval={usage.pendingApproval} testID={`${props.testID}:approval-pending`} />
      {usage.choices.length === 0 && usage.firstGateway ? (
        <Item
          testID={`${props.testID}:first`}
          title={t('settingsProvidersCollection.gateway.poolSectionTitle')}
          titleAccessory={
            <Text style={styles.via}>
              {t('settingsProvidersCollection.gateway.poolSwitchVia', {
                gateway: firstGatewayTitle,
              })}
            </Text>
          }
          // Until the Account catalog is current the switch only waits; no machine is involved (D11).
          subtitle={t('settingsProvidersCollection.gateway.poolSwitchCreates', {
            gateway: firstGatewayTitle,
          })}
          subtitleLines={0}
          showChevron={false}
          rightElement={
            <Switch
              testID={`${props.testID}:first:toggle`}
              accessibilityLabel={[
                t('settingsProvidersCollection.gateway.poolSectionTitle'),
                t('settingsProvidersCollection.gateway.poolSwitchVia', {
                  gateway: firstGatewayTitle,
                }),
              ].join(' ')}
              value={usage.pending}
              disabled={!usage.ready || usage.pending}
              onValueChange={(next) => {
                if (next) first();
              }}
            />
          }
          rightElementOutsidePressable
        />
      ) : null}
      {usage.choices.map((choice) => {
        const rowTestID = `${props.testID}:${choice.connectionId}`;
        // The row reads on only while this pool holds the slot AND the gateway is on; a held slot on an
        // off gateway says so and leads to the gateway's one switch instead of claiming to serve.
        const waitsForGateway = choice.enabled && !choice.gatewayOn;
        const serving = choice.enabled && choice.gatewayOn;
        const held = choice.replacementTarget
          ? (props.presentTarget?.(choice.replacementTarget) ??
            t('common.unavailable'))
          : null;
        return (
          <React.Fragment key={`${choice.connectionId}/${choice.purpose}`}>
            <Item
              testID={rowTestID}
              title={t('settingsProvidersCollection.gateway.poolSectionTitle')}
              titleAccessory={
                <Text style={styles.via}>
                  {t('settingsProvidersCollection.gateway.poolSwitchVia', {
                    gateway: choice.title,
                  })}
                </Text>
              }
              subtitle={
                waitsForGateway
                  ? t('settingsProvidersCollection.gateway.poolSwitchGatewayOff', { gateway: choice.title })
                  : held !== null
                    ? t(
                        'settingsProvidersCollection.gateway.poolSwitchHeldBy',
                        {
                          gateway: choice.title,
                          current: held,
                          service: props.serviceLabel,
                        },
                      )
                    : t(
                        'settingsProvidersCollection.gateway.poolSwitchDescription',
                        { service: props.serviceLabel },
                      )
              }
              subtitleLines={0}
              showChevron={false}
              rightElement={
                <Switch
                  testID={`${rowTestID}:toggle`}
                  accessibilityLabel={[
                    t('settingsProvidersCollection.gateway.poolSectionTitle'),
                    t('settingsProvidersCollection.gateway.poolSwitchVia', {
                      gateway: choice.title,
                    }),
                  ].join(' ')}
                  value={serving}
                  disabled={!usage.ready || usage.pending || waitsForGateway}
                  onValueChange={(next) => write(choice.connectionId, next)}
                />
              }
              rightElementOutsidePressable
            />
            {choice.enabled ? (
              <>
                {serving ? (
                  <SectionContentRow testID={`${rowTestID}:comparison`}>
                    <PoolGatewayComparison
                      nativeAgents={native}
                      gatewayTitle={choice.title}
                      serviceLabel={props.serviceLabel}
                    />
                  </SectionContentRow>
                ) : null}
                {props.onOpenGateway ? (
                  <Item
                    testID={`${rowTestID}:open`}
                    icon={
                      <Icon
                        name="path"
                        size={18}
                        color={theme.colors.text.secondary}
                      />
                    }
                    title={choice.title}
                    onPress={() => props.onOpenGateway?.(choice)}
                  />
                ) : null}
              </>
            ) : null}
          </React.Fragment>
        );
      })}
      {usage.error ? (
        <ProviderErrorItems
          error={usage.error}
          layout="inline"
          retry={usage.retry}
          reviewCurrentState={usage.reviewCurrentState}
        />
      ) : null}
    </ItemGroup>
  );
});

/**
 * What stays the same and what changes when other agents reach this pool through a gateway. Used
 * once, here; three short columns that keep their order on a phone.
 */
const PoolGatewayComparison = React.memo(function PoolGatewayComparison(
  props: Readonly<{
    nativeAgents: string;
    gatewayTitle: string;
    serviceLabel: string;
  }>,
) {
  const rows = [
    {
      key: 'runsThrough',
      label: t('settingsProvidersCollection.gateway.compareRunsThrough'),
      native: t('settingsProvidersCollection.gateway.compareOwnSignIn', {
        service: props.serviceLabel,
      }),
      other: props.gatewayTitle,
    },
    {
      key: 'supported',
      label: t('settingsProvidersCollection.gateway.compareSupported', {
        service: props.serviceLabel,
      }),
      native: t('settingsProvidersCollection.gateway.compareSupportedYes'),
      other: t('settingsProvidersCollection.gateway.compareSupportedNo'),
    },
    {
      key: 'limits',
      label: t('settingsProvidersCollection.gateway.compareLimits'),
      native: t('settingsProvidersCollection.gateway.compareLimitsNative'),
      other: t('settingsProvidersCollection.gateway.compareLimitsShared'),
    },
  ];
  return (
    <View style={styles.comparison} accessibilityRole="summary">
      <View style={styles.comparisonRow}>
        <View style={styles.comparisonLabel} />
        <Text style={[styles.comparisonCell, styles.comparisonHead]}>
          {props.nativeAgents
            ? t('settingsProvidersCollection.gateway.compareNative', {
                agents: props.nativeAgents,
              })
            : t('settingsProvidersCollection.gateway.compareNativeGeneric')}
        </Text>
        <Text style={[styles.comparisonCell, styles.comparisonHead]}>
          {t('settingsProvidersCollection.gateway.compareOther')}
        </Text>
      </View>
      {rows.map((row) => (
        <View
          key={row.key}
          style={[styles.comparisonRow, styles.comparisonDivider]}
        >
          <Text style={[styles.comparisonLabel, styles.comparisonLabelText]}>
            {row.label}
          </Text>
          <Text style={styles.comparisonCell}>{row.native}</Text>
          <Text style={styles.comparisonCell}>{row.other}</Text>
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  via: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.tertiary,
  },
  comparison: {
    gap: 0,
  },
  comparisonRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s12,
    paddingVertical: theme.space.s8,
  },
  comparisonDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  comparisonLabel: {
    flexBasis: '26%',
    flexGrow: 0,
    flexShrink: 0,
  },
  comparisonLabelText: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  comparisonCell: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.primary,
    flex: 1,
    minWidth: 0,
  },
  comparisonHead: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.secondary,
  },
}));
