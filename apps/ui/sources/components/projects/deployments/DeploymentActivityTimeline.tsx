import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Timeline, type TimelineItemContent } from '@happier-dev/plugin-ui';
import type { ActionActorV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { DeploymentReceiptHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type {
  DeploymentReceiptFailureV1,
  DeploymentReviewRevisionV1,
} from '@happier-dev/deployment-protocol/v1';

import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { IconButton } from '@/components/ui/buttons/IconButton';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { Text } from '@/components/ui/text/Text';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { formatElapsedDuration } from '@/components/machines/durationWords';
import { buildSessionListDateGroups } from '@/sync/domains/session/listing/sessionListDateGroups';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { useDeploymentActorPresentations } from './useDeploymentActorPresentations';
import {
  deploymentActorIsViewer,
  deploymentActorLabel,
  deploymentDurationMs,
  deploymentReceiptAtMs,
  deploymentHistoryLead,
  deploymentReceiptTitle,
  deploymentRevisionLabel,
  deploymentStateLabel,
  deploymentWorkStatus,
} from './deploymentPresentation';

export type DeploymentActivityReceipt = DeploymentReceiptHeaderV1 &
  Readonly<{
    title?: string;
    failure?: DeploymentReceiptFailureV1 | null;
    source?: DeploymentReviewRevisionV1 | null;
    /** The captured actor (history read); null when the older receipt captured none. */
    actor?: ActionActorV1 | null;
  }>;

const atOf = deploymentReceiptAtMs;

/**
 * Recent activity (lab `envOv`, owner 22:35Z): the Environment's receipts as the shared Timeline, by day. A sentence
 * always leads with who acted: "You deployed 7f3e2b1" for your own settled receipts, otherwise the person's name
 * (the shared Account profile read and actor label owners) before what happened to which version. The time holds the
 * end column and the receipt's detail is the quiet line under it.
 */
export const DeploymentActivityTimeline = React.memo(
  function DeploymentActivityTimeline(
    props: Readonly<{
      receipts: readonly DeploymentActivityReceipt[];
      accountId: string;
      /** The viewer's Account lifetime: other people's names come from the shared profile read under it. */
      lifetime: ServerAccountScopeLifetime | null;
      /** Stable from the producer; each row binds its own id. */
      onOpen: (deploymentId: string) => void;
      testID?: string;
    }>,
  ) {
    const days = React.useMemo(
      () =>
        buildSessionListDateGroups({
          items: props.receipts,
          readMeaningfulActivityAt: atOf,
        }),
      [props.receipts],
    );
    const { accountId, onOpen, lifetime } = props;
    // Who acted is the receipt's captured actor through the one actor display owner; the requester is audit only.
    const actors = React.useMemo(() => props.receipts.map((receipt) => receipt.actor), [props.receipts]);
    const presentations = useDeploymentActorPresentations({ actors, scope: lifetime?.scope ?? NO_SCOPE,
      accountLifetime: lifetime, active: lifetime !== null });
    const presentationById = React.useMemo(() => new Map(props.receipts.map((receipt, index) =>
      [receipt.id, presentations[index]] as const)), [presentations, props.receipts]);
    const renderItem = React.useCallback(
      (receipt: DeploymentActivityReceipt): TimelineItemContent => {
        const byYou = deploymentActorIsViewer(receipt.actor, accountId);
        const presentation = presentationById.get(receipt.id);
        const actorName = byYou || !presentation ? null : deploymentActorLabel(presentation, receipt.actor, accountId);
        return activityContent(receipt, byYou, actorName, onOpen);
      },
      [accountId, onOpen, presentationById],
    );
    return (
      // The public Timeline on a core page: the app's theme, type roles and icons, as a plugin surface receives them.
      <CorePluginUiPresentationScope>
      <View style={styles.stream} testID={props.testID}>
        {days.map((day) => (
          <Timeline<DeploymentActivityReceipt>
            key={day.dateKey}
            inline
            timeAlign="end"
            accessibilityLabel={day.title}
            header={
              <Text variant="meta" style={styles.day}>
                {day.title}
              </Text>
            }
            items={day.items}
            keyForItem={keyOf}
            renderItem={renderItem}
          />
        ))}
      </View>
      </CorePluginUiPresentationScope>
    );
  },
);

const keyOf = (receipt: DeploymentActivityReceipt) => receipt.id;
/** Read nothing without a lifetime: the hook is disabled then, so this scope is never queried. */
const NO_SCOPE: ServerAccountScope = Object.freeze({ serverId: '', accountId: '' });

function activityContent(
  receipt: DeploymentActivityReceipt,
  byYou: boolean,
  /** Who acted when it isn't the viewer in person (a name, an agent and whose session, a workflow); never guessed. */
  actorName: string | null,
  onOpen: (id: string) => void,
): TimelineItemContent {
  const version = receipt.source
    ? deploymentRevisionLabel(receipt.source)
    : null;
  const settled = receipt.state === 'succeeded';
  const sentence =
    byYou && settled && version ? youDid(receipt.operation, version) : null;
  const lead = deploymentHistoryLead(receipt, receipt.failure);
  const duration = deploymentDurationMs(receipt);
  const detail = [
    ...(sentence ? [] : byYou ? [t('projects.deployments.byYou')] : []),
    ...(duration !== null
      ? [
          t('projects.deployments.took', {
            duration: formatElapsedDuration(duration),
          }),
        ]
      : []),
  ].join(' · ');
  return {
    glyph: (
      <WorkStatusGlyph
        status={deploymentWorkStatus(receipt.state)}
        testIDSuffix={`deployment-${receipt.id}`}
      />
    ),
    heading: sentence ? (
      <>
        <Text variant="reading" style={styles.sentence} emphasis="medium">
          {t('projects.deployments.overviewStatus.activityYou')}
        </Text>{' '}
        <Text variant="reading" style={styles.sentence}>{sentence}</Text>
      </>
    ) : (
      // Who, when the profile owner names them, then what the operation did to which version ("Rolled back to
      // 302cf72"), the same title History reads.
      <Text variant="reading" style={styles.sentence} emphasis="medium">
        {actorName ? `${actorName} · ` : null}
        {receipt.source
          ? deploymentReceiptTitle(receipt, version)
          : (receipt.title ?? deploymentStateLabel(receipt.state))}
      </Text>
    ),
    time: (
      <Text variant="meta" style={styles.time}>
        {formatAsOfTime(atOf(receipt), atOf(receipt)) /* the day group says the day; the row says only its time */}
      </Text>
    ),
    body:
      lead || detail ? (
        <Text variant="meta" style={styles.detail} numberOfLines={2}>
          {lead ? (
            <Text
              variant="meta"
              style={
                lead.tone === 'danger'
                  ? styles.danger
                  : lead.tone === 'warning'
                    ? styles.warning
                    : null
              }
            >
              {lead.text}
            </Text>
          ) : null}
          {lead && detail ? ' · ' : null}
          {detail}
        </Text>
      ) : undefined,
    trailing: (
      <IconButton
        testID={`project-deployments.receipt.row.${receipt.id}`}
        iconName="caret-right"
        variant="plain"
        accessibilityLabel={t(
          'projects.deployments.overviewStatus.openReceipt',
        )}
        onPress={() => onOpen(receipt.id)}
      />
    ),
  };
}

function youDid(
  operation: DeploymentReceiptHeaderV1['operation'],
  version: string,
): string {
  switch (operation) {
    case 'deploy':
      return t('projects.deployments.overviewStatus.activityDeployed', {
        version,
      });
    case 'rollback':
      return t('projects.deployments.overviewStatus.activityRolledBack', {
        version,
      });
    case 'promote':
      return t('projects.deployments.overviewStatus.activityPromoted', {
        version,
      });
    case 'teardown':
      return t('projects.deployments.overviewStatus.activityRemoved');
  }
}

const styles = StyleSheet.create((theme) => ({
  stream: { gap: theme.space.s8 },
  sentence: { color: theme.colors.text.primary },
  day: { color: theme.colors.text.tertiary, paddingTop: theme.space.s4 },
  time: { color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
  detail: { color: theme.colors.text.secondary },
  danger: { color: theme.colors.state.danger.textForeground },
  warning: { color: theme.colors.state.attention.textForeground },
}));
