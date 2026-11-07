import * as React from 'react';
import { View } from 'react-native';
import type { AutonomousExchangeRootV1 } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';
import { useSessionExchangeControl } from '@/hooks/session/useSessionExchangeControl';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

type CheckInControl = 'continue' | 'continue_more_10' | 'stop';

/**
 * The exact exchange root a Session's held input is paused on for a check-in (lab T1), or null. The one
 * selector for every host that mounts the banner: the Session composer and a Discussion's participants.
 */
export function findExchangeCheckInRoot(
  pendingMessages: ReadonlyArray<Pick<PendingMessage, 'pendingDeliveryBlockedReason' | 'pendingAutonomousExchangeRoot'>> | undefined,
): AutonomousExchangeRootV1 | null {
  return pendingMessages?.find((message) => message.pendingDeliveryBlockedReason === 'autonomous_check_in')
    ?.pendingAutonomousExchangeRoot ?? null;
}

/**
 * The check-in agents pause for (lab T1): how many times they asked each other, and Stop / Continue
 * 10 more / Continue. The composer banner owner draws it; the session and Settings → Coordination's
 * preview share this one presentation.
 */
export function ExchangeCheckInBannerView(
  props: Readonly<{
    testID: string;
    count: number;
    body: string;
    pending?: CheckInControl | null;
    disabled?: boolean;
    onControl?: (control: CheckInControl) => void;
  }>,
): React.ReactElement {
  const disabled = props.disabled === true || (props.pending ?? null) !== null;
  const run = (control: CheckInControl) => () => props.onControl?.(control);
  return (
    <WarningActionBanner
      testID={props.testID}
      iconName="pause-circle"
      title={t('settingsCoordination.checkInBanner.title', {
        count: props.count,
      })}
      body={props.body}
      actionsPlacement="title"
      actionLabel={t('settingsCoordination.checkInBanner.continue')}
      actionTestID={`${props.testID}.continue`}
      actionBusy={props.pending === 'continue'}
      disabled={disabled}
      onActionPress={run('continue')}
      secondaryActions={[
        {
          key: 'stop',
          variant: 'quiet',
          label: t('settingsCoordination.checkInBanner.stop'),
          accessibilityLabel: t('settingsCoordination.checkInBanner.stop'),
          testID: `${props.testID}.stop`,
          disabled,
          onPress: run('stop'),
        },
        {
          key: 'continue_more_10',
          label: t('settingsCoordination.checkInBanner.continueMore'),
          accessibilityLabel: t(
            'settingsCoordination.checkInBanner.continueMore',
          ),
          testID: `${props.testID}.continue_more`,
          disabled,
          onPress: run('continue_more_10'),
        },
      ]}
    />
  );
}

/** Settings' "What you'll see": the real banner at static props, not a control. */
export function ExchangeCheckInBannerPreview(
  props: Readonly<{ count: number }>,
): React.ReactElement {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <ExchangeCheckInBannerView
        testID="exchange-check-in.preview"
        count={props.count}
        body={t('settingsCoordination.checkInBanner.since')}
      />
    </View>
  );
}

/**
 * The held `autonomous_check_in` input's banner, bound to the exact original root it carries
 * (`PendingMessage.pendingAutonomousExchangeRoot`); the root may belong to another same-Account
 * Session. Nothing is drawn until the exchange is read, and once it no longer asks for a check-in.
 */
export function SessionExchangeCheckInBanner(
  props: Readonly<{
    serverId: string;
    root: AutonomousExchangeRootV1;
  }>,
): React.ReactElement | null {
  const address = React.useMemo(
    () => ({ serverId: props.serverId, sessionId: props.root.sessionId }),
    [props.root.sessionId, props.serverId],
  );
  const exchange = useSessionExchangeControl(address, props.root.localId);
  const control = React.useCallback(
    (kind: CheckInControl) => {
      fireAndForget(exchange.control(kind), {
        tag: `SessionExchangeCheckInBanner.${kind}`,
      });
    },
    [exchange.control],
  );
  if (!exchange.observation) {
    if (!exchange.error) return null;
    return (
      <WarningActionBanner
        testID="session.exchange-check-in"
        iconName="pause-circle"
        title={t('settingsCoordination.checkInBanner.unavailable')}
        actionLabel={t('common.retry')}
        actionTestID="session.exchange-check-in.retry"
        actionBusy={exchange.refreshing}
        disabled={exchange.refreshing}
        onActionPress={() => exchange.refresh()}
      />
    );
  }
  if (exchange.admission !== 'check_in') return null;
  return (
    <ExchangeCheckInBannerView
      testID="session.exchange-check-in"
      count={exchange.observation.status.state.observedStarts}
      body={
        exchange.error
          ? t('settingsCoordination.checkInBanner.failed')
          : t('settingsCoordination.checkInBanner.body')
      }
      pending={exchange.pending}
      onControl={control}
    />
  );
}
