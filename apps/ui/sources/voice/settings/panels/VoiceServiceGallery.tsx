import * as React from 'react';
import { useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import { HappierPageSheet, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { ConnectedServiceMark } from '@/components/settings/connectedServices/ConnectedServiceMark';
import type { VoiceServiceMark as VoiceServiceMarkIdentity } from '@happier-dev/plugin-sdk/voice';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { projectPluginUiHostPalette } from '@/components/plugins/surfaces/pluginUiThemeProjection';

export const VOICE_SERVICE_OFF_ID = '__off__';

/**
 * In the setup card a service tile keeps its name, what it uses and its readiness. Sized so the
 * desktop card's step column holds two tiles side by side (lab SB) while a phone's stacks them (SBp).
 */
const SETUP_TILE_MIN_WIDTH_PX = 170;

/** One renderer for the public identity declaration, independent of plugin origin. */
export function VoiceServiceMark(props: Readonly<{ identity: VoiceServiceMarkIdentity | undefined; size?: number }>): React.ReactElement | null {
  const identity = props.identity;
  const size = props.size ?? 16;
  if (identity?.kind === 'connected_service') return <ConnectedServiceMark legacyServiceId={identity.serviceId} size="inline" />;
  if (identity?.kind === 'agent') return <AgentIcon agentId={identity.agentId} size={size} />;
  if (identity?.kind === 'icon') return <Icon name={resolvePluginUiIconName(identity.name)} size={size} />;
  return null;
}

/** One conversation service as the gallery shows it: who it is, what it is for, and whether it is ready. */
export type VoiceServiceTile = Readonly<{
  id: string;
  title: string;
  subtitle?: string;
  mark?: React.ReactNode;
  /**
   * Readiness in a few words. `detail` is the full prerequisite: assistive tech reads it on the tile;
   * the selected service's card above the gallery explains it on screen.
   */
  status: Readonly<{ tone: 'ready' | 'needs_you'; text: string; detail?: string }> | null;
  selected: boolean;
  disabled: boolean;
  badge?: string;
  testID: string;
}>;

/**
 * The Service gallery of Voice conversations: one tile per conversation service plus Off, each with
 * its readiness. A service is one tile whatever pays for it; billing is chosen beneath the gallery.
 * Selecting a tile never changes another service's setup.
 */
export function VoiceServiceGallery(props: Readonly<{
  tiles: readonly VoiceServiceTile[];
  offSelected: boolean;
  onSelect: (id: string) => void;
  onSelectOff: () => void;
  /**
   * `setup`: the Voice setup block's step 1 (lab SB) — who listens, without Off (turning conversations
   * off belongs to settings), one concise line per tile, one tile per line in a narrow card.
   */
  presentation?: 'page' | 'setup';
  /**
   * Where the page is too narrow for tiles side by side, the gallery is one row naming the service in
   * use that pushes this list of services (lab C1p). Without it the tiles always show.
   */
  onOpenServiceList?: () => void;
}>) {
  const { theme } = useUnistyles();
  const setup = props.presentation === 'setup';
  const windowWidth = useWindowDimensions().width;
  const [narrow, setNarrow] = React.useState(() => windowWidth < PAGE_LIST_METRICS.rowStackBelowWidthPx);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (!Number.isFinite(width) || width <= 0) return;
    const next = width < PAGE_LIST_METRICS.rowStackBelowWidthPx;
    setNarrow((current) => (current === next ? current : next));
  }, []);
  const options = React.useMemo((): Array<SelectionTile<string>> => [
    ...props.tiles.map((tile) => ({
      id: tile.id,
      title: tile.title,
      subtitle: tile.subtitle,
      mark: tile.mark,
      disabled: tile.disabled,
      badge: tile.badge,
      testID: tile.testID,
    })),
    ...(setup ? [] : [{
      id: VOICE_SERVICE_OFF_ID,
      title: t('settingsVoice.mode.off'),
      subtitle: t('settingsVoice.pages.conversations.offDescription'),
      mark: <Icon name="x" size={16} color={theme.colors.text.secondary} />,
      testID: 'settings.voice.provider.off',
    }]),
  ], [props.tiles, setup, theme.colors.text.secondary]);
  const statusById = React.useMemo(
    () => new Map(props.tiles.map((tile) => [tile.id, tile.status])),
    [props.tiles],
  );
  const selectedId = props.offSelected
    ? VOICE_SERVICE_OFF_ID
    : props.tiles.find((tile) => tile.selected)?.id ?? null;

  if (props.onOpenServiceList && narrow) {
    const selected = props.tiles.find((tile) => tile.selected) ?? null;
    return (
      <View onLayout={onLayout}>
        <HappierPageSheet colors={projectPluginUiHostPalette(theme)}>
        <Item
          testID="settings.voice.service.current"
          icon={props.offSelected ? <Icon name="x" size={20} color={theme.colors.text.secondary} /> : selected?.mark}
          title={props.offSelected || !selected ? t('settingsVoice.mode.off') : selected.title}
          subtitle={props.offSelected || !selected
            ? t('settingsVoice.pages.conversations.offDescription')
            : selected.status?.text ?? selected.subtitle}
          subtitleLines={0}
          accessibilityRole="button"
          onPress={props.onOpenServiceList}
        />
        </HappierPageSheet>
      </View>
    );
  }

  return (
    <View onLayout={props.onOpenServiceList ? onLayout : undefined}>
    <SelectionTiles<string>
      options={options}
      value={selectedId}
      density="compact"
      {...(setup ? { subtitleLines: 0, minimumColumns: 2, maximumColumns: 2, minimumTileWidth: SETUP_TILE_MIN_WIDTH_PX } : { subtitleLines: 3, minimumColumns: 3 })}
      accessibilityLabel={t('settingsVoice.pages.conversations.serviceTitle')}
      testIdPrefix="settings.voice.service"
      onChange={(next) => {
        if (next === null) return;
        if (next === VOICE_SERVICE_OFF_ID) props.onSelectOff();
        else props.onSelect(next);
      }}
      renderOptionFooter={({ option, selected }) => {
        const status = statusById.get(option.id);
        if (!status) return null;
        return (
          <View style={styles.footer} accessible accessibilityLabel={status.detail ?? status.text}>
            {/* The dot carries the tone; the words stay quiet so a gallery of choices never reads as broken. */}
            {/* The dot sits on the first line, so a readiness that wraps (setup's narrow tiles) still reads as one fact. */}
            <View style={styles.footerDot}>
              <StatusDot
                color={status.tone === 'ready' ? theme.colors.state.success.foreground
                  : selected ? theme.colors.state.warning.foreground : theme.colors.text.tertiary}
                size={6}
              />
            </View>
            <Text numberOfLines={setup ? undefined : 1} style={styles.footerText}>{status.text}</Text>
          </View>
        );
      }}
    />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  footerDot: {
    height: happierPageTextMetrics('rowDescription').lineHeight,
    justifyContent: 'center',
  },
  footerText: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    flexShrink: 1,
    color: theme.colors.text.tertiary,
  },
}));
