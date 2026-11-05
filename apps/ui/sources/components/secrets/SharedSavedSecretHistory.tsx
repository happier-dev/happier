import * as React from 'react';
import type { SavedSecretDisclosureHistoryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';

import { useSharedSavedSecretActivity } from '@/components/secrets/useSharedSavedSecretActivity';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Item } from '@/components/ui/lists/Item';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getDeviceAnalyticsId } from '@/track/settingsAnalytics/deviceAnalyticsIdentity';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

type HistoryEntry = ReturnType<
  typeof SavedSecretDisclosureHistoryV1Schema.parse
>['items'][number];

/** What one disclosure did, in one phrase: whether the value was shown, then whether it was copied. */
function historyOutcomeLabel(entry: HistoryEntry): string {
  if (entry.outcome === 'displayed') {
    if (entry.copyOutcome === 'succeeded')
      return t('secretsSettings.historyRevealedCopied');
    if (entry.copyOutcome !== null)
      return t('secretsSettings.historyCopyNotConfirmed');
    return t('secretsSettings.historyRevealed');
  }
  if (entry.outcome === 'requested' || entry.outcome === 'outcome_unknown')
    return t('secretsSettings.historyUnconfirmed');
  return t('secretsSettings.historyNotShown');
}

/**
 * Who revealed or copied a managed Saved Secret, from which device, and when: metadata only, from
 * the generalized disclosure history. It reads only while visible (its page is shown) and
 * refreshes from the history's own push; the value itself never appears here. The section that hosts
 * it carries the "Reveal history" title; loading, none yet and a failed read are its one line.
 */
export const SharedSavedSecretHistory = React.memo(
  function SharedSavedSecretHistory(
    props: Readonly<{
      testID: string;
      scope: ServerAccountScope;
      resourceId: string;
      enabled: boolean;
    }>,
  ) {
    const activity = useSharedSavedSecretActivity({
      scope: props.scope,
      resourceId: props.resourceId,
      enabled: props.enabled,
    });
    const state = activity.state;
    const thisDevice = getDeviceAnalyticsId();
    if (!props.enabled) return null;
    return (
      <>
        {state.status === 'ready' && state.entries.length === 0 ? (
          <EmptyState testID={props.testID} layout="line" title={t('secretsSettings.historyEmpty')} />
        ) : state.status !== 'ready' ? (
          <SectionContentRow>
            <SurfaceStateCard
              testID={props.testID}
              kind={state.status === 'refused' ? 'warning' : 'loading'}
              size="line"
              title={state.status === 'refused' ? t('secretsSettings.historyUnavailable') : t('common.loading')}
              accessibilitySemantics="status"
            />
          </SectionContentRow>
        ) : null}
        {state.status === 'ready'
          ? state.entries.map((entry, index) => (
              <Item
                key={entry.id}
                testID={`${props.testID}:${index}`}
                title={historyOutcomeLabel(entry)}
                subtitle={[
                  entry.actorIsSelf === true
                    ? t('message.accountActorYou')
                    : entry.actorDisplayName ??
                      t('secretsSettings.historyUnknownActor'),
                  entry.deviceId === thisDevice
                    ? t('secretsSettings.historyThisDevice')
                    : t('secretsSettings.historyOtherDevice'),
                ].join(' · ')}
                detail={formatShortRelativeTime(Date.parse(entry.createdAt))}
                density="compact"
                mode="info"
                showChevron={false}
                showDivider={false}
              />
            ))
          : null}
        {state.status === 'ready' && state.nextCursor ? (
          <SectionContentRow>
            <RoundButton
              size="small"
              display="secondary"
              testID={`${props.testID}:older`}
              title={t('secretsSettings.historyOlder')}
              onPress={activity.loadMore}
            />
          </SectionContentRow>
        ) : null}
      </>
    );
  },
);
