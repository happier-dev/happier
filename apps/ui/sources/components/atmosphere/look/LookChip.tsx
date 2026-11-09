import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { t } from '@/text';
import type { AtmosphereSurface } from '../useAtmosphere';
import {
  useHomeAtmosphereEditor,
  type AtmosphereEditor,
} from './atmosphereEditor';
import { LookPanel } from './LookPanel';

const LOOK_CHIP_EDGES_PX = { leading: 3, trailing: 3, bottom: 4 } as const;

/** The lab's popover width; on a phone the shared sheet takes the screen's width. */
const LOOK_POPOVER_WIDTH_PX = 380;
const LOOK_POPOVER_MAX_HEIGHT_PX = 720;

/**
 * Which atmosphere Look edits. Home and new session edit the Account's Home atmosphere; a project
 * screen edits its own override, so it passes the project's editor (owned with the project rows).
 */
export type LookTarget =
  | Readonly<{ surface: 'home' | 'new-session'; editor?: undefined }>
  | Readonly<{
      surface: Extract<AtmosphereSurface, { project: unknown }>;
      editor: AtmosphereEditor;
    }>;

function LookContent(props: Readonly<{ target: LookTarget }>) {
  return props.target.editor ? <LookPanel editor={props.target.editor} testID="look-panel" /> : <HomeLookContent />;
}

function HomeLookContent() {
  const home = useHomeAtmosphereEditor();
  return (
    <LookPanel
      editor={home}
      testID="look-panel"
    />
  );
}

/**
 * The Look panel, opened from an anchor: a glass popover on desktop and the shared sheet on a phone.
 * Its content mounts only while open, so a closed chip holds no atmosphere or picture subscriptions.
 * A Look in another context (a public profile's draft) passes its own panel as children.
 */
export function LookPopover(
  props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    interactionBoundaryRef?: React.RefObject<unknown>;
    /** Another anchored editor in the same panel (a public profile's Public data) names itself. */
    accessibilityLabel?: string;
  } & ({ target: LookTarget; children?: undefined } | { target?: undefined; children: React.ReactNode })>,
) {
  if (!props.open) return null;
  const content = props.target ? <LookContent target={props.target} /> : props.children;
  return (
    <Popover
      open
      phonePresentation="sheet"
      accessibilityLabel={props.accessibilityLabel ?? t('settingsAppearance.glassControls.look')}
      anchorRef={props.anchorRef}
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
      maxWidthCap={LOOK_POPOVER_WIDTH_PX}
      maxHeightCap={LOOK_POPOVER_MAX_HEIGHT_PX}
      onRequestClose={props.onRequestClose}
      interactionBoundaryRef={props.interactionBoundaryRef}
    >
      {({ maxHeight, maxWidth, presentation }) =>
        presentation === 'sheet' ? (
          content
        ) : (
          <View testID="look-popover">
            {/* A large anchored editor (Look, a profile's Details and Public data): the panel coat keeps its captions legible over a band. */}
            <FloatingOverlay
              role="panel"
              maxHeight={Math.min(maxHeight, LOOK_POPOVER_MAX_HEIGHT_PX)}
              edgeFades={{ top: true, bottom: true, size: 18 }}
              surfaceChrome="theme"
              keyboardShouldPersistTaps="always"
              containerStyle={{
                width: Math.min(maxWidth, LOOK_POPOVER_WIDTH_PX),
              }}
            >
              {content}
            </FloatingOverlay>
          </View>
        )
      }
    </Popover>
  );
}

/**
 * Look: the top-right chip on Home (beside the picture credit), the new-session screen and project
 * screens. It only opens the panel; everything the panel changes applies as it is chosen.
 */
export const LookChip = React.memo(function LookChip(
  props: Readonly<{
    target: LookTarget;
    testID?: string;
    /** Set when another control opens the same panel too (the caption's Backdrop). */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }>,
) {
  const anchorRef = React.useRef<View | null>(null);
  const [ownOpen, setOwnOpen] = React.useState(false);
  const open = props.open ?? ownOpen;
  const setOpen = props.onOpenChange ?? setOwnOpen;
  const close = React.useCallback(() => setOpen(false), [setOpen]);
  const label = t('settingsAppearance.glassControls.look');
  const { theme } = useUnistyles();
  return (
    <View ref={anchorRef} collapsable={false}>
      <GlassSurface surfaceGroup="floating" style={styles.chip}>
        <IconButton
          testID={props.testID ?? 'look-chip'}
          variant="plain"
          // A quiet glyph in the 28 px chip (lab: 15 px in secondary ink; the kit's small size); it darkens while open.
          icon={<Icon name="palette" size={ICON_SIZE.sm} color={open ? theme.colors.text.primary : theme.colors.text.secondary} />}
          accessibilityLabel={label}
          tooltip={open ? undefined : label}
          selected={open}
          expanded={open}
          // The top-right slot keeps 6 px between the caption chip and this one, and 9 px above the composer's
          // field accessories: this chip takes 4 px of that, the accessories the other 5.
          interactiveTargetEdgesPx={LOOK_CHIP_EDGES_PX}
          onPress={() => setOpen(!open)}
        />
      </GlassSurface>
      <LookPopover
        target={props.target}
        open={open}
        anchorRef={anchorRef}
        onRequestClose={close}
      />
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  // The glass clips its own material to the pill; the pill itself never clips, so the chip's hit area
  // reaches past it (DESIGN.md → touch targets are hit areas).
  chip: { borderRadius: 999 },
}));
