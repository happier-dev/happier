import * as React from 'react';
import { Platform, View } from 'react-native';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { readCoarsePrimaryPointer } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { RowActionRevealSlot } from '@/components/sessions/transcript/messageActions/RowActionRevealSlot';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { WidgetSheetShell } from '@/components/widgets/flow/WidgetFlowShell';
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
 * A group's ⋯ in its header and in Customize's group bar: the one group menu, revealed with the
 * hovered group on a fine pointer (always shown for touch or while it has keyboard focus).
 */
export function WidgetGroupMenuButton(
  props: Readonly<{
    input: WidgetGroupMenuInput;
    /** The group is hovered; `true` where the menu is always shown (Customize). */
    visible: boolean;
    anchorRef?: React.RefObject<View | null>;
    testID: string;
  }>,
) {
  const phone = useDeviceType() === 'phone';
  // Shown with the hovered group on a fine pointer; touch has no hover, so it is always there.
  const revealed = props.visible || Platform.OS !== 'web' || readCoarsePrimaryPointer();
  const title = describeWidgetGroup(props.input.group, props.input.childTitle);
  return (
    <View ref={props.anchorRef} collapsable={false} testID={props.testID}>
      {/* The shared reveal owner: it fades, takes no clicks while hidden, and shows itself on keyboard focus. */}
      <RowActionRevealSlot revealed={revealed}>
      <ItemRowActions
        // Names the menu for assistive tech only: it is anchored to its group, so no row repeats the name.
        title={title}
        compactThreshold={ALWAYS_OVERFLOW}
        compactActionIds={[]}
        // The group ⋯ carries inline Width, Frame and Dividers controls (lab wgmenu M: 340 wide, nothing scrolls).
        overflowMaxWidthCap={GROUP_MENU_WIDTH_PX}
        overflowMaxHeightCap={WIDGET_MENU_MAX_HEIGHT_PX}
        overflowTriggerTestID={`${props.testID}.trigger`}
        overflowTriggerAccessibilityLabel={`${t('widgetFrame.groupMenu')}: ${title}`}
        renderOverflowSurface={phone ? ({ children, onRequestClose }) => (
          // Lab wgphone Mp: the sheet names the group once ("happier · Group · 4 widgets") with Done.
          <WidgetSheetShell
            title={title}
            heading={{ meta: t('widgetFrame.groupWidgetCount', { count: props.input.group.children.length }), doneTestID: `${props.testID}.done` }}
            onRequestClose={onRequestClose}
            testID={`${props.testID}.sheet`}
          >
            {children}
          </WidgetSheetShell>
        ) : undefined}
        renderOverflowSection={({ id }) =>
          renderWidgetGroupMenuSection(
            props.input,
            id,
            `${props.testID}.options`,
          )
        }
        actions={buildWidgetGroupActions(props.input)}
      />
      </RowActionRevealSlot>
    </View>
  );
}
