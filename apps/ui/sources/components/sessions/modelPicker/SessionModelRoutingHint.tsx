import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { resolveAgentConnectedAccountPurposeDefaults } from '@happier-dev/protocol/account/settings/connected-services';
import type { ConnectedServicePoolSelectionGetResponseV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { ConnectedAccountIdentityText } from '@/components/settings/connectedServices/ConnectedAccountIdentityText';
import { readUsageWidgetSelection } from '@/components/settings/usage/usageWidgetSelectionRead';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useConnectedAccountPurposeDefaults } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import { useConnectedServiceQuotaSummaries } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { presentConnectedAccountNames } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import {
  buildSessionModelRoutingHint,
  sessionModelRoutingHintPoolKey,
  type SessionModelRoutingHintCandidate,
  type SessionModelRoutingHintPool,
  type SessionModelRoutingHintTarget,
} from './sessionModelRoutingHint';

type SelectionState =
  | ConnectedServicePoolSelectionGetResponseV1
  | 'loading'
  | 'failed';

/**
 * The picker's disableable routing hint (lab `d2route` R1, without its cross-Agent "most room"
 * ranking): for the selected Agent's own pools, the account the daemon selector uses and its order.
 * Mounted only while the picker is open; off means no read at all.
 */
export function SessionModelRoutingHint(
  props: Readonly<{
    entry: ResolvedAgentCatalogEntry;
    machineId: string | null;
    testID?: string;
  }>,
) {
  const [enabled, setEnabled] = useSettingMutable('usageRoutingHintsEnabled');
  if (enabled === false) return null;
  return <RoutingHintBody {...props} onHide={() => setEnabled(false)} />;
}

function RoutingHintBody(
  props: Readonly<{
    entry: ResolvedAgentCatalogEntry;
    machineId: string | null;
    testID?: string;
    onHide: () => void;
  }>,
) {
  const { catalog, legacySettings } = useConnectedAccountPurposeDefaults();
  const { entry } = props;
  const targets = React.useMemo(
    (): readonly SessionModelRoutingHintTarget[] =>
      entry.identity && catalog.value
        ? resolveAgentConnectedAccountPurposeDefaults({
            settings: legacySettings,
            purposeBindings: catalog.value,
            agentId: entry.agentId,
            consumer: entry.identity,
            declarations: entry.connectedAccounts,
          }).flatMap((value) => (value.target ? [value.target] : []))
        : [],
    [
      catalog.value,
      entry.agentId,
      entry.connectedAccounts,
      entry.identity,
      legacySettings,
    ],
  );
  const pools = React.useMemo(
    () =>
      targets.flatMap((target) => (target.kind === 'group' ? [target] : [])),
    [targets],
  );
  const poolsKey = pools.map(sessionModelRoutingHintPoolKey).join('\u0000');
  const [selections, setSelections] = React.useState<
    ReadonlyMap<string, SelectionState>
  >(new Map());
  React.useEffect(() => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!props.machineId || !lifetime || pools.length === 0) {
      setSelections(
        new Map(
          pools.map((pool) => [
            sessionModelRoutingHintPoolKey(pool),
            'failed' as const,
          ]),
        ),
      );
      return;
    }
    const abort = new AbortController();
    setSelections(new Map());
    for (const pool of pools) {
      void readUsageWidgetSelection({
        lifetime,
        signal: abort.signal,
        request: {
          machineId: props.machineId,
          group: { service: pool.service, groupId: pool.groupId },
        },
      }).then((result) => {
        if (!abort.signal.aborted)
          setSelections((current) =>
            new Map(current).set(
              sessionModelRoutingHintPoolKey(pool),
              result.ok ? result.result : 'failed',
            ),
          );
      });
    }
    return () => abort.abort();
    // Pool identities, not the array instance, decide what to read.
  }, [poolsKey, props.machineId]);
  const hint = buildSessionModelRoutingHint({
    enabled: true,
    targets,
    selections,
  });
  // Names only from what this launch already read: opening the picker never starts a quota read.
  const summaries = useConnectedServiceQuotaSummaries({
    fetchPolicy: 'cache_only',
  });
  const { present } = useConnectedAccountIdentityPrivacy();
  const names = React.useMemo(
    () =>
      presentConnectedAccountNames(
        summaries.summaries.map((summary) => ({
          key: `${summary.service.pluginId}/${summary.service.localId}:${summary.profileId}`,
          serviceTitle: summary.serviceLabel,
          displayName: summary.accountLabel ?? summary.profileLabel ?? null,
          email: summary.accountEmail ?? null,
          accountId: summary.profileId,
          presentIdentity: present,
        })),
      ),
    [present, summaries.summaries],
  );
  const serviceLabelOf = (pool: SessionModelRoutingHintPool) =>
    summaries.summaries.find(
      (summary) =>
        summary.service.pluginId === pool.group.service.pluginId &&
        summary.service.localId === pool.group.service.localId,
    )?.serviceLabel ?? pool.group.service.localId;
  const nameOf = (
    pool: SessionModelRoutingHintPool,
    candidate: SessionModelRoutingHintCandidate,
  ) => {
    const key = `${pool.group.service.pluginId}/${pool.group.service.localId}:${candidate.accountId}`;
    const summary = summaries.summaries.find(
      (entry) =>
        `${entry.service.pluginId}/${entry.service.localId}:${entry.profileId}` ===
        key,
    );
    return (
      summary?.planLabel ??
      names.get(key)?.primaryLabel ??
      t('connectedServicesCollection.accountLabel', {
        service: serviceLabelOf(pool),
      })
    );
  };
  if (!hint) return null;
  return (
    <View
      testID={props.testID ?? 'session-model-routing-hint'}
      style={styles.section}
    >
      <Text style={styles.title} accessibilityRole="header">
        {t('usage.board.plans.hintTitle')}
      </Text>
      {hint.pools.map((pool) => (
        <View
          key={pool.key}
          style={styles.pool}
          testID={`session-model-routing-hint.${pool.group.groupId}`}
        >
          <Text style={styles.poolName} numberOfLines={1}>
            {t('usage.board.plans.usedFirstPool', {
              service: serviceLabelOf(pool),
            })}
          </Text>
          {pool.state === 'ready' && pool.selected ? (
            <View style={styles.poolBody}>
              <View style={styles.selectedLine}>
                <ConnectedAccountIdentityText
                  value={nameOf(pool, pool.selected)}
                  style={styles.selected}
                  numberOfLines={1}
                />
                <Text style={styles.quiet} numberOfLines={1}>
                  {[
                    pool.selected.remainingPercent !== null
                      ? t('usage.board.plans.cellLeft', {
                          percent: `${Math.round(pool.selected.remainingPercent)}%`,
                        })
                      : null,
                    pool.selected.sticky
                      ? t('usage.board.plans.hintSticky')
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              {pool.next.length > 0 ? (
                <Text style={styles.quiet} numberOfLines={1}>
                  {t('usage.board.plans.hintThen', {
                    names: pool.next
                      .map((candidate) => nameOf(pool, candidate))
                      .join(', '),
                  })}
                </Text>
              ) : null}
            </View>
          ) : (
            <Text style={styles.quiet}>
              {pool.state === 'loading'
                ? t('usage.board.plans.hintLoading')
                : t('usage.board.plans.hintUnavailable')}
            </Text>
          )}
        </View>
      ))}
      <View style={styles.footer}>
        <Text style={styles.footerText} numberOfLines={1}>
          {t('usage.board.plans.hintFooter')}
        </Text>
        <HappierPressable
          testID="session-model-routing-hint.hide"
          accessibilityRole="button"
          onPress={props.onHide}
          accessibilityLabel={t('usage.board.plans.hintHide')}
        >
          <Text style={styles.hide}>{t('usage.board.plans.hintHide')}</Text>
        </HappierPressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: theme.colors.surface.inset,
  },
  title: {
    ...Typography.default('semiBold'),
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.text.secondary,
  },
  pool: { gap: 2 },
  poolName: {
    ...Typography.default(),
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.text.tertiary,
  },
  poolBody: { gap: 1 },
  selectedLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    columnGap: 8,
    flexWrap: 'wrap',
  },
  selected: {
    ...Typography.default('medium'),
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.text.primary,
  },
  quiet: {
    ...Typography.default(),
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingTop: 2,
  },
  footerText: {
    ...Typography.default(),
    fontSize: 11.5,
    lineHeight: 16,
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
  hide: {
    ...Typography.default('medium'),
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.text.link,
  },
}));
