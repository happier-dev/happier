import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { OptionPickerBandRow } from '@/components/sessions/pickers/OptionPickerOverlay';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
  presentSessionRouteSourceSubtitle,
  type SessionRouteSourceRow,
} from '@/providers/session/buildSessionRouteSourceRows';

import type { SessionModelPickerSourceGroup } from './selectSessionModelPickerSourceGroups';
import { sessionModelSelectionKey } from './sessionModelSelectionKey';

export type SessionModelPickerSource =
  SessionModelPickerSourceGroup['sources'][number];

const ROW = 'model-picker-runs-through';


/**
 * The selected model's "Runs through" row (lab round 4 B; owner decisions 2026-11-18 and 2026-11-19). How many
 * sources serve the model is decided once by `selectSessionModelPickerSourceGroups`; this row only presents its
 * answer. Two serving sources are a two-part switch. Otherwise the row names the chosen source and its usage and
 * ends in one icon button that opens the source menu (no "Change" word, no boxed select); the menu also lists
 * hidden, signed-out and needs-key sources. A Provider source reads its name and its one state from the
 * Runs-through content model (`buildSessionRouteSourceRows`, the composer popover's rows), so the two surfaces
 * never word a source differently. Picking a source is the picker's decision (`onPick`): it commits that source's
 * exact model, browses a hidden one, or opens the recovery a signed-out source needs.
 */
export function SessionModelRunsThrough(
  props: Readonly<{
    group: SessionModelPickerSourceGroup;
    selectedKey: string;
    /** The name of a source the content model does not list (the Agent's own sign-in). */
    sourceLabel: (source: SessionModelPickerSource) => string;
    routeRows?: readonly SessionRouteSourceRow[];
    renderUsage?: (source: SessionModelPickerSource) => React.ReactNode;
    onPick: (source: SessionModelPickerSource) => void;
  }>,
) {
  const { group, selectedKey, onPick } = props;
  const [menuOpen, setMenuOpen] = React.useState(false);
  const rowOf = (source: SessionModelPickerSource) => source.providerConnectionId === null
    ? undefined
    : props.routeRows?.find((row) => row.connectionId === source.providerConnectionId);
  const sourceLabel = (source: SessionModelPickerSource) => rowOf(source)?.label ?? props.sourceLabel(source);
  const current = group.sources.find((source) =>
    source.options.some(
      (option) => sessionModelSelectionKey(option.value) === selectedKey,
    ),
  );
  const label = t('connectedServices.authChip.popoverTitle');
  if (!current) return null;
  const usage = props.renderUsage?.(current) ?? null;
  // One accessible name for the source button and the source line: what it runs through now, and that it changes.
  const buttonLabel = t('agentInput.model.runsThroughChange', { source: sourceLabel(current) });
  const pick = (key: string) => {
    if (key === current.key) return;
    const source = group.sources.find((candidate) => candidate.key === key);
    if (source) onPick(source);
  };
  if (group.sourceCount === 2) {
    const tabs = group.sources
      .filter((source) => source.state === 'ready')
      .map((source) => ({ id: source.key, label: sourceLabel(source) }));
    return (
      <OptionPickerBandRow testID={ROW} label={label}>
        <View testID={`${ROW}:switch`} style={styles.control}>
          <SegmentedTabBar
            role="radiogroup"
            tabs={tabs}
            activeTabId={current.key}
            onSelectTab={pick}
            segmentSizing="equal"
            testIDPrefix={`${ROW}:switch`}
            accessibilityLabel={label}
            compact
            activeLabelStyle={Typography.default('semiBold')}
          />
        </View>
        {usage}
      </OptionPickerBandRow>
    );
  }
  // Ready sources first, in the selector's order; then the ones a person must act on before they can serve it.
  const ordered = [
    ...group.sources.filter((source) => source.state === 'ready'),
    ...group.sources.filter((source) => source.state !== 'ready'),
  ];
  const items = ordered.map((source) => {
    const row = rowOf(source);
    return {
      id: source.key,
      title: sourceLabel(source),
      subtitle: row ? presentSessionRouteSourceSubtitle(row) : undefined,
      checked: source.key === current.key,
      testID: `${ROW}:menu:${source.key}`,
    };
  });
  return (
    <OptionPickerBandRow
      testID={ROW}
      label={label}
      placement="beside"
      detail={
        <>
          {/* The source name opens the same menu: a larger target than the icon alone (review 9). */}
          <HappierPressable
            testID={`${ROW}:value-press`}
            onPress={() => setMenuOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={buttonLabel}
            hasPopup="menu"
            expanded={menuOpen}
            style={styles.valuePress}
          >
            <Text testID={`${ROW}:value`} numberOfLines={1} style={styles.value}>
              {sourceLabel(current)}
            </Text>
          </HappierPressable>
          {usage}
        </>
      }
    >
      <DropdownMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        items={items}
        selectedId={current.key}
        onSelect={(id) => {
          setMenuOpen(false);
          pick(id);
        }}
        placement="bottom"
        // The trigger is an icon: the menu takes the menu width, not the button's.
        matchTriggerWidth={false}
        // On a phone the menu floats from its button over the picker rather than replacing it (owner 11-18, decision 2).
        popoverPhonePresentation="anchored"
        // Inside the engine popover a screen-local host would paint the menu under it (as the field select does).
        popoverPortalWebTarget="body"
        trigger={({ toggle }) => (
          <IconButton
            testID={`${ROW}:sources`}
            iconName="arrows-down-up"
            variant="plain"
            size={28}
            iconSize={16}
            accessibilityLabel={buttonLabel}
            tooltip={t('agentInput.model.chooseSource')}
            hasPopup="menu"
            expanded={menuOpen}
            onPress={toggle}
          />
        )}
      />
    </OptionPickerBandRow>
  );
}

/**
 * The favourite remembers the Thinking it was starred with; a later session change never rewrites it (owner
 * decision 2026-11-18). When the two differ, one quiet line says so and Update re-saves the favourite.
 */
export function SessionModelFavoriteEffortNote(
  props: Readonly<{
    slot: number;
    effortLabel: string;
    onUpdate: () => void;
  }>,
) {
  return (
    <View testID="model-picker-favorite-effort-note" style={styles.note}>
      <Text style={styles.noteText}>
        {t('agentInput.model.favoriteUsesEffort', {
          slot: props.slot,
          effort: props.effortLabel,
        })}
      </Text>
      <Text style={styles.noteText}>·</Text>
      <TextLinkButton
        testID="model-picker-favorite-effort-update"
        label={t('agentInput.model.updateFavoriteEffort')}
        size="meta"
        tone="strong"
        onPress={props.onUpdate}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  value: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  control: { flex: 1, minWidth: 0 },
  valuePress: { alignSelf: 'flex-start', maxWidth: '100%' },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    flexWrap: 'wrap',
  },
  noteText: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
}));
