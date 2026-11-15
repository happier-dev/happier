import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  HAPPIER_WIDGET_FRAME_METRICS,
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';
import type { WidgetGroupWidthV1 } from '@happier-dev/protocol/widgets';

import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { WidgetFrameNameField } from '@/components/widgets/frame/useWidgetFrameRename';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { WidgetGroupMenuButton } from './WidgetGroupMenuButton';
import {
  describeWidgetGroup,
  resolveWidgetGroupWidthChoices,
  isWidgetGroupWidthAvailable,
  type WidgetGroupMenuInput,
} from './widgetGroupMenu';

/**
 * A group's bar while its surface is being customized or organized (lab `widget-groups` wgmenu E),
 * in the place of its header: the grip that lifts the whole group, its name as a field, Half | Full
 * and the group ⋯. An untitled group's options live here; a width the group cannot take stays
 * visible and says which widget prevents it. Home and every widget area draw this one bar.
 */
export function WidgetGroupBar(
  props: Readonly<{
    input: WidgetGroupMenuInput;
    /** The group's name write; absent where this viewer cannot rename it (the name is then text). */
    onRename?: ((next: string) => void | Promise<void>) | undefined;
    /** The group's grip: the whole group lifts by its bar. */
    grip?: React.ReactNode;
    anchorRef?: React.RefObject<View | null>;
    testID: string;
    serverId?: string | null;
  }>,
) {
  const { group, operations } = props.input;
  // An unnamed group reads as the names of its widgets, as Sections names it; typing sets a real name.
  const title = describeWidgetGroup(group, props.input.childTitle);
  const widths = isWidgetGroupWidthAvailable(props.input)
    ? resolveWidgetGroupWidthChoices(group.children, props.input.childTitle)
    : [];
  const tabs = React.useMemo(
    () =>
      widths.map((choice) => ({
        id: choice.width,
        label: t(
          choice.width === 'half'
            ? 'widgetFrame.widthHalf'
            : 'widgetFrame.widthFull',
        ),
        ...(choice.unavailableReason
          ? { disabled: true, unavailableReason: choice.unavailableReason }
          : {}),
      })),
    [widths],
  );
  const reason = widths.find(
    (choice) => choice.unavailableReason,
  )?.unavailableReason;
  // The field is the rename; the menu beside it does not offer a second one.
  const menuInput = React.useMemo(
    () =>
      props.onRename ? { ...props.input, onRename: undefined } : props.input,
    [props.input, props.onRename],
  );
  return (
    <View testID={props.testID} style={styles.bar}>
      {props.grip ?? null}
      {props.onRename ? (
        <WidgetFrameNameField
          testID={`${props.testID}.name`}
          value={title}
          placeholder={t('widgetFrame.groupUntitled')}
          accessibilityLabel={t('widgetFrame.groupName')}
          onRename={props.onRename}
          serverId={props.serverId}
        />
      ) : (
        <Text style={styles.name} numberOfLines={1}>
          {title || t('widgetFrame.groupUntitled')}
        </Text>
      )}
      <View style={styles.rest}>
        {reason ? (
          <Text
            testID={`${props.testID}.widthReason`}
            style={styles.reason}
            numberOfLines={1}
          >
            {reason}
          </Text>
        ) : null}
      </View>
      {tabs.length ? (
        <SegmentedTabBar<WidgetGroupWidthV1>
          tabs={tabs}
          activeTabId={group.width}
          onSelectTab={(width) => operations.setWidth(group.id, width)}
          segmentSizing="content"
          role="radiogroup"
          accessibilityLabel={t('widgetFrame.groupWidth')}
          testIDPrefix={`${props.testID}.width`}
        />
      ) : null}
      <WidgetGroupMenuButton
        input={menuInput}
        anchorRef={props.anchorRef}
        testID={`${props.testID}.menu`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The header's own box, so entering Customize never moves the group's widgets.
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: HAPPIER_WIDGET_FRAME_METRICS.headerGapPx,
    minHeight: HAPPIER_WIDGET_FRAME_METRICS.headerMinHeightPx,
    paddingLeft: HAPPIER_WIDGET_FRAME_METRICS.headerTrailingInsetPx,
    paddingRight: HAPPIER_WIDGET_FRAME_METRICS.headerTrailingInsetPx,
  },
  name: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('sectionTitle'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  rest: { flex: 1, minWidth: 0, alignItems: 'flex-end' },
  reason: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
}));
