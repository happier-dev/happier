import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { OptionPickerBandRow } from '@/components/sessions/pickers/OptionPickerOverlay';
import {
  SegmentedTabBar,
  SegmentedValueSelect,
} from '@/components/ui/navigation/SegmentedTabBar';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { SessionModelPickerSourceGroup } from './selectSessionModelPickerSourceGroups';
import { sessionModelSelectionKey } from './sessionModelSelectionKey';

export type SessionModelPickerSource =
  SessionModelPickerSourceGroup['sources'][number];

const ROW = 'model-picker-runs-through';

/** What a source says beside its name in the menu: only states that change what picking it does. */
function sourceStateLabel(
  source: SessionModelPickerSource,
): string | undefined {
  if (source.state === 'signed-out')
    return t('agentInput.model.sourceSignedOut');
  if (source.state === 'needs-key') return t('agentInput.model.sourceNeedsKey');
  if (source.state === 'unavailable') return t('common.unavailable');
  return source.hidden ? t('agentInput.model.sourceHidden') : undefined;
}

/**
 * The selected model's "Runs through" row (lab A2; owner decisions 2026-11-18). How many sources serve the
 * model is decided once by `selectSessionModelPickerSourceGroups`; this row only presents its answer. One
 * serving source is a plain value with nothing to press. Two are a two-part switch. Three or more are the
 * bordered field select, whose floating menu also lists hidden, signed-out and needs-key sources. Picking a
 * source is the picker's decision (`onPick`): it commits that source's exact model, browses a hidden one, or
 * opens the recovery a signed-out source needs.
 */
export function SessionModelRunsThrough(
  props: Readonly<{
    group: SessionModelPickerSourceGroup;
    selectedKey: string;
    sourceLabel: (source: SessionModelPickerSource) => string;
    onPick: (source: SessionModelPickerSource) => void;
  }>,
) {
  const { group, selectedKey, sourceLabel, onPick } = props;
  const current = group.sources.find((source) =>
    source.options.some(
      (option) => sessionModelSelectionKey(option.value) === selectedKey,
    ),
  );
  const label = t('connectedServices.authChip.popoverTitle');
  if (!current) return null;
  if (group.sourceCount <= 1) {
    return (
      <OptionPickerBandRow testID={ROW} label={label}>
        <Text testID={`${ROW}:value`} numberOfLines={1} style={styles.value}>
          {sourceLabel(current)}
        </Text>
      </OptionPickerBandRow>
    );
  }
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
      </OptionPickerBandRow>
    );
  }
  // Ready sources first, in the selector's order; then the ones a person must act on before they can serve it.
  const ordered = [
    ...group.sources.filter((source) => source.state === 'ready'),
    ...group.sources.filter((source) => source.state !== 'ready'),
  ];
  const tabs = ordered.map((source) => ({
    id: source.key,
    label: sourceLabel(source),
    unavailableReason: sourceStateLabel(source),
  }));
  return (
    <OptionPickerBandRow testID={ROW} label={label}>
      <View style={styles.selectSlot}>
        <SegmentedValueSelect
          tabs={tabs}
          activeTabId={current.key}
          onSelectTab={pick}
          disabled={false}
          accessibilityLabel={label}
          testID={`${ROW}:select`}
        />
      </View>
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
  selectSlot: { alignSelf: 'flex-start' },
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
