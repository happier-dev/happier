import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';

import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { PageHeaderPlaceholder } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { HomeHubReadingColumn } from './HomeHubSectionList';

const LOADING_STATE = { kind: 'loading' } as const;

/**
 * Home while its page or its model is still coming: Home's own shape in place (the greeting, the composer and the
 * rows of the section under it), never a generic page. It reads nothing, so the shell can draw it while Home's
 * chunk loads, and Home draws the same thing until its model answers: the two waits read as one.
 */
export const HomeHubLoading = React.memo(function HomeHubLoading(
  props: Readonly<{ testID: string }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  return (
    <ItemList testID={props.testID} pageColumn="dashboard">
      <View
        accessible
        role="status"
        accessibilityLabel={t('common.loading')}
        accessibilityLiveRegion="polite"
      >
        <HomeHubReadingColumn>
          <PageHeaderPlaceholder testID={`${props.testID}-greeting`} />
          <ItemGroup surface="none">
            <GlassSurface
              testID={`${props.testID}-composer`}
              surfaceGroup="card"
              finishRole="composer"
              style={styles.composer}
            >
              <HappierSkeletonBlock
                color={theme.colors.surface.skeleton}
                reducedMotion={reducedMotion}
                width="60%"
                height={theme.space.s12}
                radius={theme.space.s4}
              />
              <View style={styles.strip}>
                <View style={styles.stripLine}>
                  <HappierSkeletonBlock
                    color={theme.colors.surface.skeleton}
                    reducedMotion={reducedMotion}
                    width="40%"
                    height={theme.space.s10}
                    radius={theme.space.s4}
                  />
                </View>
                <View style={styles.stripLine}>
                  <HappierSkeletonBlock
                    color={theme.colors.surface.skeleton}
                    reducedMotion={reducedMotion}
                    width="28%"
                    height={theme.space.s10}
                    radius={theme.space.s4}
                  />
                </View>
              </View>
            </GlassSurface>
          </ItemGroup>
          <ItemGroup testID={`${props.testID}-section`}>
            <ItemLoadStateRows state={LOADING_STATE} rows={2} lines={1} />
          </ItemGroup>
        </HomeHubReadingColumn>
      </View>
    </ItemList>
  );
});

const styles = StyleSheet.create((theme) => ({
  // The composer's own material and corner (`HubComposerSection`'s held composer), its field line and its
  // instrument strip's two lines, so the composer that arrives takes about the room this one held.
  composer: {
    padding: theme.space.s16,
    gap: theme.space.s16,
    borderRadius: theme.parts.composer.radius,
  },
  strip: { gap: theme.space.s4 },
  stripLine: {
    height: theme.space.s32,
    justifyContent: 'center',
  },
}));
