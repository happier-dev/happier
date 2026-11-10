import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useIsWidgetFrameBody } from '@/components/widgets/frame/widgetFrameBody';
import { useWidgetFrameBodyMeta } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { visuallyHiddenStyle } from '@/components/ui/accessibility/visuallyHiddenStyle';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
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
 * never blank; a widget or a section among siblings keeps only its header. Not announced: it names
 * the cause and offers Retry.
 */
export function CheckoutUnreachableState(
  props: Readonly<{
    reachability: CheckoutReachability;
    size?: SurfaceStateSize;
    /** One section among siblings: the line would repeat under each of them, so it stays wordless. */
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
    const testID = props.testID ?? 'checkout-unreachable';
    if (!widget && !props.silent) {
      return (
        <SurfaceStateCard
          testID={testID}
          kind="unavailable"
          size="line"
          iconName="wifi-slash"
          title={t('projects.checkouts.waiting', { machine: reachability.machineName })}
        />
      );
    }
    return <AnnouncedCheckoutWait machineName={reachability.machineName} testID={testID} />;
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
 * A widget or sibling section waiting on an announced machine, with nothing last-known to show: it
 * keeps only its header. No placeholder rows (they read as loading that never
 * ends) and no second sentence. In a widget frame the header's meta slot carries the one quiet
 * offline glyph, so the bare heading reads as unavailable, not as unfinished. Assistive technology
 * still hears what it waits for.
 */
function AnnouncedCheckoutWait(
  props: Readonly<{ machineName: string; testID: string }>,
) {
  const { theme } = useUnistyles();
  const glyph = React.useMemo(
    () => (
      <Icon
        name="wifi-slash"
        size={ICON_SIZE.sm}
        color={theme.colors.text.tertiary}
      />
    ),
    [theme.colors.text.tertiary],
  );
  useWidgetFrameBodyMeta(glyph);
  // Spoken, not drawn: a label on a role-less box is never read, so the words are a visually hidden text.
  return (
    <View testID={props.testID}>
      <Text style={visuallyHiddenStyle}>
        {t('projects.checkouts.waiting', { machine: props.machineName })}
      </Text>
    </View>
  );
}
