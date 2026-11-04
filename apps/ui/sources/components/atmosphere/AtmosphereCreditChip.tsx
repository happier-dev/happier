import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_FOCUS_RING_DELEGATED_STYLE,
  HAPPIER_PRESS_FEEDBACK_V1,
  HappierPressable,
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';
import type { AtmospherePicture } from '@happier-dev/brand/atmosphere';
import { useReleaseNotesLauncher, useReleaseNotesUnread } from '@/changelog/releaseNotes';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { readCurrentAppRuntimeInfo } from '@/sync/runtime/readCurrentAppRuntimeInfo';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { useAtmosphereMoment } from './atmosphereMoments';
import { LookChip, type LookTarget } from './look/LookChip';
import { lookCopy } from './look/LookControls';
import { pictureCreditLine, pictureTitle } from './look/pictureCredit';

/** The lab's caption card width; on a phone the shared sheet takes the screen's width. */
const CAPTION_POPOVER_WIDTH_PX = 300;
/** Text in the card starts where a popover menu's row text does. */
const CARD_INSET_PX = MENU_ROW_METRICS.insetPx + MENU_ROW_METRICS.paddingHorizontalPx;

/**
 * The caption's card: the picture's credit, then What's new for this version (the existing release
 * notes, only while the release caption moment is on) and Backdrop (the Look panel). The same content
 * sits in the desktop popover and the phone sheet.
 */
function PictureCaptionCard(
  props: Readonly<{
    picture: AtmospherePicture;
    version: string | null;
    onWhatsNew: () => void;
    onBackdrop: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { picture, version } = props;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        {version ? (
          <>
            <Text style={styles.cardVersion}>{version}</Text>
            <View style={styles.dot} />
          </>
        ) : null}
        <Text numberOfLines={1} style={styles.cardTitle}>
          {pictureTitle(picture)}
        </Text>
      </View>
      <HappierPressable
        accessibilityRole="link"
        testID="atmosphere.caption.credit"
        onPress={() => {
          void openExternalUrl(picture.credit.url);
        }}
      >
        {({ hovered }) => (
          <Text numberOfLines={2} style={[styles.credit, hovered && styles.creditHovered]}>
            {pictureCreditLine(picture)}
          </Text>
        )}
      </HappierPressable>
      <View style={styles.divider} />
      <View style={[styles.actions, version ? null : styles.actionsEnd]}>
        {version ? <HappierPressable
          testID="atmosphere.caption.whats-new"
          accessibilityRole="link"
          onPress={props.onWhatsNew}
          style={HAPPIER_FOCUS_RING_DELEGATED_STYLE}
        >
          {({ hovered, pressed, focused }) => (
            <View
              style={[
                styles.action,
                focusRingStyle({ focused, color: theme.colors.border.focus }),
                { opacity: pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1 },
              ]}
            >
              <Text numberOfLines={1} style={[styles.whatsNew, hovered && styles.underline]}>
                {t('releaseNotes.whatsNewInVersion', { version })}
              </Text>
              <Icon name="caret-right" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
            </View>
          )}
        </HappierPressable> : null}
        <HappierPressable
          testID="atmosphere.caption.backdrop"
          hasPopup="dialog"
          onPress={props.onBackdrop}
          style={HAPPIER_FOCUS_RING_DELEGATED_STYLE}
        >
          {({ hovered, pressed, focused }) => (
            <View
              style={[
                styles.action,
                focusRingStyle({ focused, color: theme.colors.border.focus }),
                { opacity: pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1 },
              ]}
            >
              <Icon
                name="palette"
                size={ICON_SIZE.xs}
                color={hovered ? theme.colors.text.primary : theme.colors.text.secondary}
              />
              <Text numberOfLines={1} style={[styles.backdrop, hovered && styles.backdropHovered]}>
                {lookCopy('backdrop')}
              </Text>
            </View>
          )}
        </HappierPressable>
      </View>
    </View>
  );
}

/**
 * The picture's caption, top right of an atmosphere surface (lab `at-cap`): the picture's name in a
 * small glass chip, with its author for assistive technology. Pressing it opens the caption card (the
 * credit, linking to its source, and Backdrop) from the top-right slot, or the shared sheet on a phone.
 * With the release caption moment on (U9 `releaseCaption`) the card adds this version and What's new,
 * and while that release is unread the chip reads "version · picture" (on a phone, only the version), so
 * it announces a new release once and is the picture's quiet credit afterwards.
 */
const PictureCaption = React.memo(function PictureCaption(
  props: Readonly<{
    picture: AtmospherePicture;
    /** This version while the release caption moment is on. */
    version: string | null;
    anchorRef: React.RefObject<View | null>;
    onBackdrop: () => void;
  }>,
) {
  const { picture, onBackdrop } = props;
  const { theme } = useUnistyles();
  const { hasUnread } = useReleaseNotesUnread();
  // The chip announces only an unread release; once read it is the credit alone.
  const version = hasUnread ? props.version : null;
  const phone = useDeviceType() === 'phone';
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  const { openWhatsNew } = useReleaseNotesLauncher();
  const whatsNew = React.useCallback(() => {
    setOpen(false);
    openWhatsNew();
  }, [openWhatsNew]);
  const backdrop = React.useCallback(() => {
    setOpen(false);
    onBackdrop();
  }, [onBackdrop]);
  const card = (
    <PictureCaptionCard picture={picture} version={props.version} onWhatsNew={whatsNew} onBackdrop={backdrop} />
  );
  const title = pictureTitle(picture);
  const name = `${title}, ${picture.credit.author}`;
  return (
    <>
      <HappierPressable
        testID={version ? 'atmosphere.caption' : 'atmosphere.credit'}
        accessibilityLabel={version ? `${version} · ${name}` : name}
        hasPopup="dialog"
        expanded={open}
        onPress={() => setOpen((previous) => !previous)}
        // Half the 6 px gap to the Look chip beside it.
        hitReach={{ left: 3, right: 3 }}
        style={HAPPIER_FOCUS_RING_DELEGATED_STYLE}
      >
        {({ pressed, focused }) => (
          <View
            style={[
              styles.chipFrame,
              focusRingStyle({ focused, color: theme.colors.border.focus }),
              { opacity: pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle : 1 },
            ]}
          >
            <GlassSurface surfaceGroup="card" style={styles.chip}>
              <View style={[styles.row, phone && version && styles.rowPhone]}>
                {version ? <Text style={styles.version}>{version}</Text> : null}
                {version && phone ? null : (
                  <>
                    {version ? <View style={styles.dot} /> : null}
                    <Text numberOfLines={1} style={styles.title}>
                      {title}
                    </Text>
                  </>
                )}
              </View>
            </GlassSurface>
          </View>
        )}
      </HappierPressable>
      {open ? (
        <Popover
          open
          phonePresentation="sheet"
          accessibilityLabel={title}
          anchorRef={props.anchorRef}
          autoFocusOnOpen
          placement="bottom"
          gap={8}
          edgePadding={{ horizontal: 8, vertical: 8 }}
          portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
          maxWidthCap={CAPTION_POPOVER_WIDTH_PX}
          onRequestClose={close}
        >
          {({ maxWidth, presentation }) =>
            presentation === 'sheet' ? (
              card
            ) : (
              <View testID="atmosphere.caption.popover">
                <FloatingOverlay
                  surfaceChrome="theme"
                  scrollEnabled={false}
                  containerStyle={{ width: Math.min(maxWidth, CAPTION_POPOVER_WIDTH_PX) }}
                >
                  {card}
                </FloatingOverlay>
              </View>
            )
          }
        </Popover>
      ) : null}
    </>
  );
});

/** The installed app's version, as the runtime reports it; it does not change while the app runs. */
const readAppVersion = () => readCurrentAppRuntimeInfo().appVersion;

/**
 * The top-right slot of an atmosphere surface: the picture's caption (or plain credit), then the Look
 * chip. Backdrop in the caption opens the same Look popover as the chip.
 */
export const AtmosphereTopChips = React.memo(function AtmosphereTopChips(
  props: Readonly<{
    picture: AtmospherePicture | null;
    lookTarget: LookTarget;
  }>,
) {
  const { picture } = props;
  const slotRef = React.useRef<View | null>(null);
  const [lookOpen, setLookOpen] = React.useState(false);
  const openLook = React.useCallback(() => setLookOpen(true), []);
  const caption = useAtmosphereMoment('releaseCaption').on;
  const version = React.useMemo(readAppVersion, []);
  return (
    <View ref={slotRef} collapsable={false} style={styles.slot}>
      {picture === null ? null : (
        <PictureCaption picture={picture} version={caption && version ? version : null} anchorRef={slotRef} onBackdrop={openLook} />
      )}
      <LookChip target={props.lookTarget} open={lookOpen} onOpenChange={setLookOpen} />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  slot: {
    position: 'absolute',
    top: 14,
    right: 16,
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  chipFrame: {
    borderRadius: 14,
  },
  chip: {
    height: 28,
    borderRadius: 14,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s10,
    maxWidth: 240,
  },
  rowPhone: {
    paddingHorizontal: theme.space.s8,
  },
  version: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('meta'),
    fontVariant: ['tabular-nums'],
    color: theme.colors.text.primary,
  },
  dot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: theme.colors.text.tertiary,
  },
  title: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  card: {
    paddingTop: theme.space.s12,
    paddingHorizontal: CARD_INSET_PX,
    paddingBottom: theme.space.s4,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  cardVersion: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    fontVariant: ['tabular-nums'],
    color: theme.colors.text.primary,
  },
  cardTitle: {
    ...Typography.default('medium'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  credit: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    marginTop: theme.space.s2,
    color: theme.colors.text.secondary,
  },
  creditHovered: {
    color: theme.colors.text.primary,
    textDecorationLine: 'underline',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginTop: theme.space.s12,
    backgroundColor: theme.colors.border.default,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s12,
    minHeight: 40,
  },
  actionsEnd: {
    justifyContent: 'flex-start',
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minHeight: MENU_ROW_METRICS.minHeightPx,
    borderRadius: 6,
  },
  whatsNew: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    fontVariant: ['tabular-nums'],
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  underline: {
    textDecorationLine: 'underline',
  },
  backdrop: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.secondary,
  },
  backdropHovered: {
    color: theme.colors.text.primary,
  },
}));
