import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ThemeMiniaturePreview } from '@/components/settings/appearance/ThemeModePreview';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import {
  OverlayMotionFrame,
  useOverlayPresence,
} from '@/components/ui/overlays/motion/overlayMotion';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

import type { ThemeTryPresentationProps } from '@/components/store/storeThemeViewTypes';

/**
 * The floating try bar (lab C2b): what this device is trying, that nothing is saved, and the two verbs that
 * settle it. It rises from the bottom edge of its host region with the popover's short entrance and leaves
 * faster; reduced motion cross-fades. It is the only control host while the listing that started the try is
 * closed, so it never doubles the listing's own Revert and Install.
 */
export function ThemeTryBar(props: ThemeTryPresentationProps) {
  const phone = useDeviceType() === 'phone';
  // The app's floating bottom bar (a phone's tab bar) reports its height; the try bar stands above it.
  const bottomChrome = useSessionCockpitBottomChromeHeight();
  const presence = useOverlayPresence(
    props.visible,
    motionTokens.overlay.popover.exitMs,
  );
  if (!presence.present) return null;
  const id = (suffix: string) =>
    props.testID ? `${props.testID}:${suffix}` : undefined;
  return (
    <View
      pointerEvents="box-none"
      style={[styles.region, phone ? styles.regionPhone : null, bottomChrome > 0 ? styles.regionAboveChrome(bottomChrome) : null]}
    >
      <OverlayMotionFrame
        visible={props.visible}
        kind="popover"
        direction="top"
        pointerEvents="box-none"
      >
        <GlassSurface
          surfaceGroup="floating"
          floatingRole="menu"
          style={[styles.bar, phone ? styles.barPhone : null]}
          testID={props.testID}
        >
          {props.miniature ? (
            <View
              style={styles.mark}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <ThemeMiniaturePreview miniature={props.miniature} />
            </View>
          ) : null}
          <View style={styles.text} accessibilityRole="text">
            <Text
              variant="label"
              emphasis="semiBold"
              numberOfLines={phone ? 2 : 1}
              style={styles.title}
            >
              {t('themeStore.tryingFace', { face: props.faceName })}
            </Text>
            <Text
              variant="meta"
              numberOfLines={phone ? 2 : 1}
              style={styles.meta}
            >
              {t('themeStore.tryingHere', { here: props.here })}
            </Text>
          </View>
          <View style={styles.actions}>
            <RoundButton
              size="small"
              display="secondary"
              title={t('themeStore.revert')}
              onPress={props.onRevert}
              loading={props.busy === 'revert'}
              disabled={props.disabled || props.busy !== null}
              testID={id('revert')}
            />
            <RoundButton
              size="small"
              title={t(props.origin === 'store' || props.origin === undefined ? 'themeStore.install' : 'themeCard.keep')}
              onPress={props.onInstall}
              loading={props.busy === 'install'}
              disabled={props.disabled || props.busy !== null}
              testID={id('install')}
            />
          </View>
        </GlassSurface>
      </OverlayMotionFrame>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  region: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: theme.space.s20,
    alignItems: 'center',
  },
  regionPhone: {
    left: theme.space.s12,
    right: theme.space.s12,
    bottom: theme.space.s24,
    alignItems: 'stretch',
  },
  regionAboveChrome: (chromeHeight: number) => ({
    bottom: chromeHeight + theme.space.s12,
  }),
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s8,
    paddingLeft: theme.space.s8,
    paddingRight: theme.space.s8,
    borderRadius: theme.borderRadius.xl,
  },
  barPhone: {
    flexWrap: 'wrap',
  },
  mark: {
    width: 40,
    height: 25,
    borderRadius: 5,
    overflow: 'hidden',
  },
  text: {
    flexShrink: 1,
    minWidth: 0,
    paddingRight: theme.space.s8,
  },
  title: {
    color: theme.colors.text.primary,
  },
  meta: {
    color: theme.colors.text.secondary,
  },
  actions: {
    flexDirection: 'row',
    gap: theme.space.s6,
    marginLeft: 'auto',
  },
}));
