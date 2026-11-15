import * as React from 'react';
import { Platform, View } from 'react-native';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

import { t } from '@/text';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import { useCoarsePrimaryPointer } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { useItemRowHovered } from '@/components/ui/lists/ItemRowHover';
import { useItemRowAccessibleName } from '@/components/ui/lists/ItemRowAccessibleName';

const ROW_MENU_BUTTON_PX = 24;
/**
 * The free space around the button inside the shortest row (the button is centred in it). Stacked rows
 * touch, so the finger reach stops at the row's own edge and a neighbour's trigger never shares it.
 */
const ROW_MENU_VERTICAL_GAP_PX =
  HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight - ROW_MENU_BUTTON_PX;

function stopPressEventPropagation(event: unknown): void {
  const maybeEvent = event as {
    stopPropagation?: () => void;
    nativeEvent?: { stopPropagation?: () => void };
  };
  try {
    maybeEvent.stopPropagation?.();
  } catch {}
  try {
    maybeEvent.nativeEvent?.stopPropagation?.();
  } catch {}
}

/**
 * A column row's ⋯ (the Projects and Services trees): quiet until the row is engaged (lab TREE shows no menu at
 * rest), it keeps its place and stays focusable, and touch screens always show it. The menu itself is mounted only
 * while open, so a closed row costs just its trigger: no item list, no icons, no dropdown hooks.
 */
export const CollectionRowMenu = React.memo(function CollectionRowMenu(
  props: Readonly<{
    testID?: string;
    renderMenu: (
      menu: Readonly<{
        anchorRef: React.RefObject<View | null>;
        onClose: () => void;
      }>,
    ) => React.ReactNode;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<View>(null);
  const rowHovered = useItemRowHovered();
  const coarsePrimaryPointer = useCoarsePrimaryPointer();
  const close = React.useCallback(() => setOpen(false), []);
  // Named after the row it sits in ("More actions for Website"), the name its row lends to its accessories.
  const rowName = useItemRowAccessibleName();
  return (
    <View ref={anchorRef} collapsable={false} style={{ position: 'relative' }}>
      <RowActionRevealSlot
        revealed={
          Platform.OS !== 'web' || coarsePrimaryPointer || rowHovered || open
        }
      >
        {/* The shared icon-only button and the row menu's glyph (the Sessions rows' "⋯"). */}
        <IconButton
          testID={props.testID}
          iconName="dots-three"
          variant="plain"
          size={ROW_MENU_BUTTON_PX}
          interactiveTargetVerticalGapPx={ROW_MENU_VERTICAL_GAP_PX}
          accessibilityLabel={rowName ? t('common.moreActionsFor', { title: rowName }) : t('common.moreActions')}
          expanded={open}
          tooltipHidden={open}
          onPress={(event) => {
            stopPressEventPropagation(event);
            setOpen((current) => !current);
          }}
        />
      </RowActionRevealSlot>
      {open ? props.renderMenu({ anchorRef, onClose: close }) : null}
    </View>
  );
});
