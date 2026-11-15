import * as React from 'react';

import { useIsWidgetFrameBody } from '@/components/widgets/frame/widgetFrameBody';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import {
  SurfaceStateCard,
  type SurfaceStateSize,
} from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';

export {
  CheckoutReachabilityScope,
  describeCheckoutUnreachable,
  retryMachineReachability,
  useAnnouncedCheckoutMachine,
  useCheckoutReachability,
  useCheckoutReachabilityPresentation,
  type CheckoutMachineScope,
  type CheckoutReachability,
} from './checkoutReachabilityModel';
import {
  describeCheckoutUnreachable,
  retryMachineReachability,
  useCheckoutReachability,
  type CheckoutMachineScope,
  type CheckoutReachability,
} from './checkoutReachabilityModel';

/**
 * The page's one line ("As of 10:42 · devbox isn't answering · Retry"), under its header. Renders
 * nothing while the machine answers.
 */
export function CheckoutReachabilityLine(
  props: Readonly<{ scope: CheckoutMachineScope; testID?: string }>,
) {
  const reachability = useCheckoutReachability(props.scope);
  return <CheckoutReachabilityLineView reachability={reachability} testID={props.testID} />;
}

/** The same line for a surface that already holds its Machine's reachability. */
export function CheckoutReachabilityLineView(
  props: Readonly<{ reachability: CheckoutReachability; testID?: string }>,
) {
  const { reachability } = props;
  // Going offline and coming back are moments, not jumps: the line reveals and folds away with the
  // shared disclosure motion (height and opacity together, instant under reduced motion), and it keeps
  // its last words while it folds.
  const shownRef = React.useRef(reachability);
  if (reachability.unreachable) shownRef.current = reachability;
  const shown = shownRef.current;
  return (
    <ExpandableItem
      expanded={reachability.unreachable}
      onExpandedChange={ignoreExpandedChange}
      header={renderNoHeader}
      showDivider={false}
    >
      {shown.unreachable ? (
        <SurfaceFreshnessLine
          testID={props.testID ?? 'checkout-reachability'}
          reason={shown.runtime.label}
          action={shown.runtime.nextAction === 'retry' ? { label: t('common.retry'), onPress: retryMachineReachability } : undefined}
        />
      ) : null}
    </ExpandableItem>
  );
}

const ignoreExpandedChange = () => {};
const renderNoHeader = () => null;

/**
 * What a surface under an unreachable checkout shows in place of its own failure. Announced above:
 * no second cause or Retry. A body of its own says in one quiet line what it waits for, so a tab is
 * never blank; a widget or a section among siblings says in that line when it shows. Not announced:
 * it names the cause and offers Retry.
 */
export function CheckoutUnreachableState(
  props: Readonly<{
    reachability: CheckoutReachability;
    size?: SurfaceStateSize;
    /** One section among siblings: its line says when it shows rather than what the page waits for. */
    silent?: boolean;
    /** What this surface shows again once the machine answers ("Your files show up here when it's back."). */
    returns?: string;
    testID?: string;
  }>,
) {
  const { reachability } = props;
  // Inside a widget it is the widget's one quiet line; elsewhere the container sizes it.
  const widget = useIsWidgetFrameBody();
  if (reachability.announced) {
    // A body of its own says what it waits for; a widget or a section among siblings says, in the same one
    // line, when it shows (owner P1 11-15: "Shown when <Machine> is reachable"), never an empty block.
    return (
      <AnnouncedCheckoutLine
        machineName={reachability.machineName}
        among={widget || props.silent === true}
        testID={props.testID ?? 'checkout-unreachable'}
      />
    );
  }
  // A machine that can be asked again is "out of reach": named in the title, when it was last seen and
  // what comes back in the reason, Try again beneath (lab p5 files). A managed machine's own state
  // (stopped, starting) is its title as it stands.
  const outOfReach = reachability.runtime.nextAction === 'retry';
  const reason = outOfReach
    ? [
        reachability.lastSeenAt
          ? t('projects.checkouts.lastSeen', { when: formatLastSeen(reachability.lastSeenAt) })
          : null,
        props.returns ?? null,
      ].filter(Boolean).join(' ') || undefined
    : props.returns;
  return (
    <SurfaceStateCard
      testID={props.testID ?? 'checkout-unreachable'}
      kind="unavailable"
      size={props.size ?? (widget ? 'line' : undefined)}
      iconName="wifi-slash"
      scene="homeOffline"
      title={describeCheckoutUnreachable(reachability)}
      reason={reason}
      action={outOfReach ? { label: t('surfaceState.tryAgain'), onPress: retryMachineReachability } : undefined}
    />
  );
}

/**
 * The one line a surface draws while the page above already says its machine is not answering: what it waits for
 * ("Waiting for studio"), or, among sibling sections, when it shows ("Shown when studio is reachable").
 */
export function AnnouncedCheckoutLine(
  props: Readonly<{ machineName: string; among: boolean; testID: string }>,
) {
  const machine = props.machineName;
  return (
    <SurfaceStateCard
      testID={props.testID}
      kind="unavailable"
      size="line"
      iconName="wifi-slash"
      title={props.among
        ? t('projects.checkouts.shownWhenReachable', { machine })
        : t('projects.checkouts.waiting', { machine })}
    />
  );
}
