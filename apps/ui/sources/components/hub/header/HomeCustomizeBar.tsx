import * as React from 'react';
import { View } from 'react-native';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { HomeWidgetAddPopoverEntry } from '@/components/widgets/add/HomeWidgetAddPopoverEntry';
import { StagedMoveDockFooter, StagedMoveDockSlotContext, useStagedMoveDockSlot } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { CustomModal } from '@/modal/components/CustomModal';
import type { CustomModalConfig } from '@/modal/types';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';

import { LookPopover } from '@/components/atmosphere/look/LookChip';

import { HomeLayoutEditor } from '../layout/HomeLayoutEditor';
import { HomeCustomizeBanner } from './HomeCustomizeBanner';

const SECTIONS_POPOVER_WIDTH_PX = 360;
const HOME_LOOK_TARGET = { surface: 'home' } as const;
const SECTIONS_POPOVER_MAX_HEIGHT_PX = 640;

/** The phone sheet's section list. */
function HomeSectionsSheetContent() {
  return <HomeLayoutEditor presentation="popover" />;
}

/**
 * Home while it is being customized (lab `widget-groups` wgmenu E): the page itself is what is
 * edited — every group shows its bar, widgets show their grips, holes show their slot and one "new
 * row" target ends the page. Nothing covers the groups.
 *
 * This bar holds what is not on a card: the list that shows, hides and orders Home's sections (with
 * Reset and the dismissed setup steps), Add widget, and Done. The list opens only when asked for,
 * anchored to its button; a phone uses the shared sheet with the same list.
 */
export const HomeCustomizeBar = React.memo(function HomeCustomizeBar(
  props: Readonly<{
    onDone: () => void;
    interactionBoundaryRef?: React.RefObject<unknown>;
  }>,
) {
  const phone = !useIsTablet();
  const sectionsAnchorRef = React.useRef<View | null>(null);
  const addAnchorRef = React.useRef<View | null>(null);
  const barRef = React.useRef<View | null>(null);
  const lookAnchorRef = React.useRef<View | null>(null);
  const [sectionsOpen, setSectionsOpen] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const [lookOpen, setLookOpen] = React.useState(false);
  // A keyboard move's key hints sit in the Sections popover's footer, clear of the rows.
  const stagedDock = useStagedMoveDockSlot();
  const toggleLook = React.useCallback(() => setLookOpen((open) => !open), []);
  const closeLook = React.useCallback(() => setLookOpen(false), []);
  const toggleSections = React.useCallback(
    () => setSectionsOpen((open) => !open),
    [],
  );
  // Opening Add never moves the page: the panel keeps its designed size and slides inside the window
  // around its trigger (the shared surface's `fit="shift"`), so nothing under it jumps.
  const toggleAdd = React.useCallback(() => setAddOpen((open) => !open), []);
  const closeSections = React.useCallback(() => setSectionsOpen(false), []);
  const closeAdd = React.useCallback(() => setAddOpen(false), []);
  const sectionsTitle = t('homeIndex.sections');
  const sheetConfig = React.useMemo<CustomModalConfig>(
    () => ({
      id: 'home-customize',
      type: 'custom',
      component: HomeSectionsSheetContent,
      props: {},
      chrome: {
        kind: 'card',
        header: 'none',
        title: sectionsTitle,
        phonePresentation: 'sheet',
        testID: 'home-hub.customize.sheet',
      },
    }),
    [sectionsTitle],
  );
  return (
    <ItemGroup surface="none">
      <HomeCustomizeBanner
        phone={phone}
        sectionsOpen={sectionsOpen}
        addOpen={addOpen}
        onToggleSections={toggleSections}
        onToggleAdd={toggleAdd}
        onDone={props.onDone}
        sectionsAnchorRef={sectionsAnchorRef}
        addAnchorRef={addAnchorRef}
        barRef={barRef}
        lookOpen={lookOpen}
        onToggleLook={toggleLook}
        lookAnchorRef={lookAnchorRef}
      />
      <LookPopover
        target={HOME_LOOK_TARGET}
        open={lookOpen}
        anchorRef={lookAnchorRef}
        onRequestClose={closeLook}
        interactionBoundaryRef={props.interactionBoundaryRef}
      />
      {sectionsOpen && phone ? (
        <CustomModal visible config={sheetConfig} onClose={closeSections} />
      ) : sectionsOpen ? (
        <Popover
          open
          anchorRef={sectionsAnchorRef}
          autoFocusOnOpen
          placement="bottom"
          gap={8}
          edgePadding={{ horizontal: 8, vertical: 8 }}
          portal={{
            web: true,
            native: true,
            matchAnchorWidth: false,
            anchorAlign: 'end',
          }}
          maxWidthCap={SECTIONS_POPOVER_WIDTH_PX}
          maxHeightCap={SECTIONS_POPOVER_MAX_HEIGHT_PX}
          onRequestClose={closeSections}
          interactionBoundaryRef={props.interactionBoundaryRef}
        >
          {({ maxHeight, maxWidth }) => (
            <View testID="home-hub.customize.popover">
              <FloatingOverlay
                footer={<StagedMoveDockFooter dock={stagedDock.dock} />}
                maxHeight={Math.min(maxHeight, SECTIONS_POPOVER_MAX_HEIGHT_PX)}
                edgeFades={{ top: true, bottom: true, size: 18 }}
                surfaceChrome="theme"
                keyboardShouldPersistTaps="always"
                containerStyle={{
                  width: Math.min(maxWidth, SECTIONS_POPOVER_WIDTH_PX),
                }}
              >
                <StagedMoveDockSlotContext.Provider value={stagedDock.slot}>
                  <HomeLayoutEditor presentation="popover" />
                </StagedMoveDockSlotContext.Provider>
              </FloatingOverlay>
            </View>
          )}
        </Popover>
      ) : null}
      {addOpen ? (
        <HomeWidgetAddPopoverEntry
          anchorRef={addAnchorRef}
          regionRef={barRef}
          onRequestClose={closeAdd}
          testID="home-hub.add"
        />
      ) : null}
    </ItemGroup>
  );
});
