import * as React from 'react';
import { View } from 'react-native';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { t } from '@/text';
import { useWidgetMenuSurface } from '@/components/widgets/flow/WidgetFlowShell';
import { WIDGET_MENU_MAX_HEIGHT_PX } from '@/components/widgets/frame/widgetFrameMenu';

import {
  buildWidgetGroupActions,
  describeWidgetGroup,
  renderWidgetGroupMenuSection,
  type WidgetGroupMenuInput,
} from './widgetGroupMenu';

/** Every action sits in the overflow menu: the header shows one quiet "⋯". */
const ALWAYS_OVERFLOW = Number.POSITIVE_INFINITY;
/** The lab's group menu (wgmenu M) is 340 wide so its segmented rows stay beside their labels. */
const GROUP_MENU_WIDTH_PX = 340;

/**
 * A group's ⋯ in its header and in Customize's group bar: the one group menu. In the header the group's
 * WidgetFrame shows it (a card always; a plain group on hover or focus); the bar always shows it.
 */
export function WidgetGroupMenuButton(
  props: Readonly<{
    input: WidgetGroupMenuInput;
    anchorRef?: React.RefObject<View | null>;
    testID: string;
  }>,
) {
  const title = describeWidgetGroup(props.input.group, props.input.childTitle);
  const menuSurface = useWidgetMenuSurface({
    title, meta: t('widgetFrame.groupWidgetCount', { count: props.input.group.children.length }), testID: props.testID,
  });
  return (
    <View ref={props.anchorRef} collapsable={false} testID={props.testID}>
      <ItemRowActions
        currentUiContext
        // Names the menu for assistive tech only: it is anchored to its group, so no row repeats the name.
        title={title}
        compactThreshold={ALWAYS_OVERFLOW}
        compactActionIds={[]}
        // The group ⋯ carries inline Width, Frame and Dividers controls (lab wgmenu M: 340 wide, nothing scrolls).
        overflowMaxWidthCap={GROUP_MENU_WIDTH_PX}
        overflowMaxHeightCap={WIDGET_MENU_MAX_HEIGHT_PX}
        overflowTriggerTestID={`${props.testID}.trigger`}
        overflowTriggerAccessibilityLabel={`${t('widgetFrame.groupMenu')}: ${title}`}
        renderOverflowSurface={menuSurface}
        renderOverflowSection={({ id }) =>
          renderWidgetGroupMenuSection(
            props.input,
            id,
            `${props.testID}.options`,
          )
        }
        actions={buildWidgetGroupActions(props.input)}
      />
    </View>
  );
}
