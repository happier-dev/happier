import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import {
  SessionComposerSample,
  SessionTranscriptSample,
} from '@/components/settings/session/SessionSettingPreviews';
import { resolveThinkingDisplayChoice } from '@/components/settings/session/thinkingDisplayChoice';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  useLocalSettingMutable,
  useSettingsSelector,
} from '@/sync/domains/state/storage';
import { t } from '@/text';

import { SampleSessionRows } from './ItemDensityPreview';

/**
 * Appearance's live preview (lab A2/A3): a small slice of the app drawn by its real owners at static
 * props — sample sessions (`Item` + `Avatar`) beside a session's conversation (the transcript rows
 * and the composer, as Personalize's stage draws them) — so the theme, text size, density, avatar style
 * and agent icons show as they are chosen, in the user's own transcript layout. It reads the settings
 * it mirrors and nothing else: no session data, no subscriptions, no RPCs.
 */
export const AppearanceLivePreview = React.memo(
  function AppearanceLivePreview() {
    const [density] = useLocalSettingMutable('uiItemDensity');
    const [fontScale] = useLocalSettingMutable('uiFontScale');
    const transcriptLayout = useSettingsSelector((settings) =>
      settings.transcriptGroupingMode === 'linear' ? 'linear' : 'turns', ["transcriptGroupingMode"],
    );
    const thinking = useSettingsSelector(resolveThinkingDisplayChoice, ['sessionThinkingDisplayMode', 'sessionThinkingInlinePresentation']);
    const toolChrome = useSettingsSelector((settings) =>
      settings.toolViewTimelineChromeMode === 'cards'
        ? 'cards'
        : 'activity_feed', ["toolViewTimelineChromeMode"],
    );
    // The slice previews the app's look, not tool output: tool rows stay at their title line, so a
    // full detail setting never fills the window with a diff or a log (or its first-load state).
    const toolDetail = 'title' as const;
    const [scale, setScale] = React.useState<number | null>(null);
    const onViewportLayout = React.useCallback((event: LayoutChangeEvent) => {
      const width = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
      if (width !== null) setScale((current) => (current === width / PREVIEW_WINDOW.width ? current : width / PREVIEW_WINDOW.width));
    }, []);
    const summary = `${t(`settingsAppearance.itemDensityOptions.${density}`)} · ${Math.round((fontScale ?? 1) * 100)}%`;
    return (
      <ItemGroup
        title={t('settingsAppearance.densityPreview.title')}
        action={<Text style={styles.summary}>{summary}</Text>}
        actionLayout="inline"
      >
        <View
          testID="settings-appearance-live-preview"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {/* The lab's slice of the app (A2/A3): the sessions column beside the open session. The
              preview only renders as the page's aside (phones leave it out), so it is never stacked. */}
          {/* The slice is drawn at a fixed window size and scaled to the aside (Personalize's miniature
              rule), so the session column keeps readable titles and the page keeps the lab's proportion. */}
          <View style={styles.viewport} pointerEvents="none" onLayout={onViewportLayout}>
          <View style={[styles.window, scale === null ? styles.unmeasured : { transform: [{ scale }] }]}>
            <View style={styles.sessions}>
              <SampleSessionRows density={density} />
            </View>
            <View style={styles.conversation} pointerEvents="none">
              <View style={styles.transcript}>
                <SessionTranscriptSample
                  layout={transcriptLayout}
                  thinking={thinking}
                  toolChrome={toolChrome}
                  toolDetail={toolDetail}
                />
              </View>
              <View style={styles.composer}>
                <SessionComposerSample layout="wrap" labels="core" width="100%" />
              </View>
            </View>
          </View>
          </View>
        </View>
      </ItemGroup>
    );
  },
);

/** The window the slice is laid out in before it is scaled to the aside's width. */
const PREVIEW_WINDOW = { width: 460, height: 600 } as const;

const styles = StyleSheet.create((theme) => ({
  summary: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  // The aside's box keeps the window's proportion before and after it is measured: nothing moves.
  viewport: {
    width: '100%',
    aspectRatio: PREVIEW_WINDOW.width / PREVIEW_WINDOW.height,
    overflow: 'hidden',
  },
  window: {
    width: PREVIEW_WINDOW.width,
    height: PREVIEW_WINDOW.height,
    flexDirection: 'row',
    alignItems: 'stretch',
    transformOrigin: 'top left',
  },
  unmeasured: {
    opacity: 0,
  },
  // The sessions column, as the app's sidebar draws it beside a session (lab: about a third).
  sessions: {
    width: '38%',
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.border.subtle,
    overflow: 'hidden',
  },
  // The open session: the transcript on the canvas it is drawn on, the composer at its foot.
  conversation: {
    flex: 1,
    minWidth: 0,
    backgroundColor: theme.colors.background.canvas,
    paddingTop: theme.space.s8,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  transcript: {
    flexShrink: 1,
    overflow: 'hidden',
  },
  composer: {
    paddingHorizontal: theme.space.s8,
    paddingBottom: theme.space.s8,
  },
}));
