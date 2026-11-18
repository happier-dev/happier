import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/**
 * "Connecting to this machine" while a surface waits on its Machine. On a page it floats over the surface, not above
 * it, so a passing state never pushes the page's header down and back. In a widget it stands in the body's flow: a
 * card hugs what its body shows (Home's content-height cards), so the card grows to hold the line instead of the
 * line covering a one-line body and being cut by the card's edge.
 */
export function PluginSurfaceConnectingLine(): React.ReactElement {
  const { theme } = useUnistyles();
  const inWidget = useWidgetPresentation() !== undefined;
  return (
    <View
      testID="plugin-surface-connecting-line"
      pointerEvents="none"
      style={[
        inWidget ? styles.inFlow : styles.floating,
        {
          backgroundColor: theme.colors.surface.base,
          borderColor: theme.colors.border.strong,
        },
      ]}
    >
      <SurfaceStateCard
        testID="plugin-surface-execution-preparing"
        kind="loading"
        size="line"
        title={t('pluginSurfaces.state.connecting.title')}
        reason={t('pluginSurfaces.state.connecting.reason')}
        accessibilitySemantics="status"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Host chrome over a pane's plugin content, on the pane's inset, never flush against its edge.
  floating: {
    position: 'absolute',
    left: 12,
    bottom: 5,
    zIndex: 1,
    maxWidth: '90%',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 8,
  },
  // In a widget body the line is part of what the body shows, so it takes room there.
  inFlow: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 8,
  },
});
