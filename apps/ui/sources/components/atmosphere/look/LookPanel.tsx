import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { GlassAppearanceControls } from '@/components/settings/appearance/GlassAppearanceControls';
import { useAtmospherePictureCatalog } from '../useAtmospherePictureCatalog';
import type { AtmospherePicture } from '@happier-dev/brand/atmosphere';
import type { AtmosphereEditor } from './atmosphereEditor';
import { LookPanelBlock, LookSegments, PictureControls, PlanetControls, SourceControl } from './LookControls';
import { useRightPanelPlacement, type RightPanelPlacement } from '@/components/appShell/panes/arrangement/useRightPanelPlacement';
import { useDeviceType } from '@/utils/platform/responsive';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';

/**
 * Look: the one control for the atmosphere behind Home, a new session or a project (lab Personalize).
 * The same content sits in the desktop popover and the phone sheet. Source first; then the planet's
 * placement, style and digits, or the picture, its look, fade, strength and layout; then the glass
 * over it (the existing glass controls, writing the existing glass settings). Every block has the one
 * panel anatomy: a small header with its control beneath.
 */
export const LookPanel = React.memo(function LookPanel(
  props: Readonly<{
    editor: AtmosphereEditor;
    testID?: string;
  }>,
) {
  const { editor } = props;
  const pictures = useAtmospherePictureCatalog();
  const same = editor.sameAsHome === true;
  // Turning it off keeps Home's current atmosphere as this project's own, to change from there.
  const setSame = (value: boolean) => {
    if (value) editor.resetToHome?.();
    else editor.update((current) => current);
  };
  return (
    <View style={styles.panel} testID={props.testID}>
      {editor.resetToHome ? (
        <Item
          testID="look-same-as-home"
          title={t('settingsAppearance.glassControls.sameAsHome')}
          subtitle={t(same ? 'settingsAppearance.glassControls.sameAsHomeOn' : 'settingsAppearance.glassControls.sameAsHomeOff')}
          showChevron={false}
          onPress={() => setSame(!same)}
          rightElement={<Switch value={same} onValueChange={setSame} />}
        />
      ) : null}
      <LookBackdropControls editor={editor} pictures={pictures} />
      <GlassAppearanceControls presentation="panel" />
      <RightPanelPlacementBlock />
    </View>
  );
});

/**
 * How the right panel stands against the page (calm-shell R4-2, R11-3), beside the glass it composes with. Only where panes
 * sit side by side, like the Appearance row; it writes the same device setting.
 */
function RightPanelPlacementBlock() {
  const deviceType = useDeviceType();
  const { placement, setPlacement } = useRightPanelPlacement();
  if (!(Platform.OS === 'web' || deviceType === 'tablet') || deviceType === 'phone') return null;
  const title = t('settingsAppearance.rightPanelPlacement');
  return (
    <LookPanelBlock title={title} testID="look-right-panel-placement">
      <LookSegments<RightPanelPlacement>
        label={title}
        testIDPrefix="look-right-panel-placement"
        options={[
          { id: 'separate', label: t('settingsAppearance.rightPanelPlacementSeparate') },
          { id: 'line', label: t('settingsAppearance.rightPanelPlacementLine') },
          { id: 'shadow', label: t('settingsAppearance.rightPanelPlacementShadow') },
        ]}
        value={placement}
        onChange={setPlacement}
      />
    </LookPanelBlock>
  );
}

/**
 * The backdrop half of Look: the source, then the planet's or the picture's controls. Home's panel adds
 * the global glass beneath; a public profile's Look shows only these, so its edits never reach glass.
 */
export function LookBackdropControls(
  props: Readonly<{
    editor: AtmosphereEditor;
    pictures: readonly AtmospherePicture[];
  }>,
) {
  const { editor, pictures } = props;
  return (
    <>
      <SourceControl editor={editor} presentation="panel" pictures={pictures} />
      {editor.value.source === 'planet' ? (
        <PlanetControls editor={editor} presentation="panel" />
      ) : editor.value.source === 'picture' ? (
        <PictureControls
          editor={editor}
          presentation="panel"
          pictures={pictures}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create(() => ({
  panel: { paddingBottom: 4 },
}));
