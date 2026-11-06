import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { EntityFlatReorderList, EntityFlatReorderRow, type EntityFlatReorderBinding } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import type { NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { t } from '@/text';

import type { AgentInputPlacementDescriptor } from '../controls/agentInputControlTypes';
import { createActionMenuTriggerChip } from '../definitions/createActionMenuTriggerChip';
import {
  AGENT_INPUT_CHIP_ICON_SIZE_PX,
  AGENT_INPUT_CHIP_ICON_STYLE,
} from '../definitions/agentInputChipIconMetrics';
import { resolveAgentInputControlLines } from '../controls/resolveAgentInputControlLines';
import { AgentInputChipLabel } from './AgentInputChipLabel';
import { AgentInputSubmitButton } from './AgentInputSubmitButton';
import { AgentInputScrollableChipRow } from '../layout/AgentInputScrollableChipRow';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import {
  AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE,
  AGENT_INPUT_ACTION_CHIP_STYLE,
  resolveAgentInputActionChipTextStyle,
  resolveAgentInputPanelStyle,
} from './agentInputChromeStyles';

const NOOP = () => {};
const PHONE_ROW_STYLE = { flex: 1, minWidth: 0, overflow: 'hidden' } as const;
const FADE_EDGE = { position: 'absolute', top: 0, bottom: 0, width: 24, zIndex: 2 } as const;
const FADE_LEFT_STYLE = { ...FADE_EDGE, left: 0 } as const;
const FADE_RIGHT_STYLE = { ...FADE_EDGE, right: 0 } as const;
const NO_REF = { current: null };
/** A chip that can be picked up says so under the pointer. */
const GRAB_CURSOR_STYLE = (Platform.OS === 'web' ? { cursor: 'grab' } : {}) as ViewStyle;

/** What a chip really shows in the composer that opened the customizer. Settings has none: a chip says its own name. */
export type ComposerPlacementPreviewValue = Readonly<{ label?: string | null; mark?: React.ReactNode; /** The composer draws no chip here right now. */ absent?: boolean }>;
export type ComposerPlacementPreviewValues = Readonly<Partial<Record<string, ComposerPlacementPreviewValue>>>;

/** The composer always draws Permissions as its glyph alone; its word lives in the menu. */
const ICON_ONLY_CONTROLS: ReadonlySet<string> = new Set(['permission']);

/**
 * The composer as a set of placement choices would draw it: the field with its accessories at the top right, then
 * the leading +, the Shown chips as they really read and the send disc, at static props. It resolves through the same
 * pure placement owner as the live row and + menu, reads nothing and subscribes to nothing, so the customizer shows
 * the effect of each choice before it is left. With `reorder` a chip is grabbed here to move it, through the same
 * reorder owner and write as the list below; a phone keeps the row's sideways scroll and reorders in the list.
 */
export const ComposerPlacementPreview = React.memo(
  function ComposerPlacementPreview(
    props: Readonly<{
      descriptors: readonly AgentInputPlacementDescriptor[];
      preferences: NavigationPlacementPreferences;
      values?: ComposerPlacementPreviewValues;
      placeholder?: string;
      /** A session's composer is one rail: its location controls ride the same line (`resolveAgentInputControlLines`). */
      singleRow?: boolean;
      reorderFor?: (ids: readonly string[]) => EntityFlatReorderBinding;
      testID?: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const tint = theme.colors.composer.chipTint;
    const textStyle = React.useMemo(
      () => resolveAgentInputActionChipTextStyle(theme),
      [theme],
    );
    // The live row's own line owner, so the picture and the composer can never disagree about a chip's line.
    const lines = resolveAgentInputControlLines({
      controls: props.descriptors,
      preferences: props.preferences,
      ...(props.singleRow ? { singleRow: true } : {}),
    });
    const descriptorsById = new Map(props.descriptors.map((descriptor) => [descriptor.id, descriptor]));
    const resolveLine = (ids: readonly string[]) => ids.flatMap((id) => {
      const descriptor = descriptorsById.get(id);
      return descriptor && !props.values?.[id]?.absent ? [descriptor] : [];
    });
    const primaryChips = resolveLine(lines.primary);
    const secondaryChips = resolveLine(lines.secondary);
    const chips = [...primaryChips, ...secondaryChips];
    const accessories = resolveLine(lines.accessories);
    const chipStyle = React.useCallback(
      () => AGENT_INPUT_ACTION_CHIP_STYLE,
      [],
    );
    const phone = useViewportClass() === 'compact';
    const phoneRowContentStyle = React.useMemo(
      () => ({ flexDirection: 'row', alignItems: 'center', gap: theme.space.s2 }) as const,
      [theme.space.s2],
    );
    const canReorder = !phone && props.reorderFor !== undefined;
    const renderChip = (descriptor: AgentInputPlacementDescriptor) => {
      // Several placements can share a control id (Actions, location chips): a placement's own value wins.
      const value = props.values?.[descriptor.id] ?? props.values?.[descriptor.controlId];
      const iconOnly = ICON_ONLY_CONTROLS.has(descriptor.controlId);
      const chip = (
        <View
          key={descriptor.id}
          testID={`composer-placement-preview.chip:${descriptor.id}`}
          style={[AGENT_INPUT_ACTION_CHIP_STYLE, iconOnly ? AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE : null, canReorder ? GRAB_CURSOR_STYLE : null]}
        >
          {value?.mark ?? (descriptor.icon ? (
            <Icon
              name={descriptor.icon}
              size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
              color={tint}
              style={AGENT_INPUT_CHIP_ICON_STYLE}
            />
          ) : null)}
          {iconOnly ? null : <AgentInputChipLabel label={value?.label || descriptor.title} textStyle={textStyle} />}
        </View>
      );
      // The whole chip is the drag body and the drop place, as a space in the strip is.
      return canReorder ? <EntityFlatReorderRow key={descriptor.id} id={descriptor.id}>{() => chip}</EntityFlatReorderRow> : chip;
    };
    const chipLine = (name: 'primary' | 'secondary', descriptors: readonly AgentInputPlacementDescriptor[]) => {
      const row = (
        <View testID={`composer-placement-preview.line:${name}`}
          style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s2 }}>
          {descriptors.map(renderChip)}
        </View>
      );
      const binding = canReorder ? props.reorderFor?.(descriptors.map((descriptor) => descriptor.id)) : undefined;
      return binding ? (
        <EntityFlatReorderList binding={binding} axis="horizontal" testID={`composer-placement-preview.reorder:${name}`} alwaysOrganizing>
          {row}
        </EntityFlatReorderList>
      ) : row;
    };
    const menuTrigger = (
      <View pointerEvents="none">
        {createActionMenuTriggerChip({
          anchorRef: NO_REF,
          tint,
          chipStyle,
          open: false,
          openStyle: { backgroundColor: theme.colors.surface.selected },
          onPress: NOOP,
        })}
      </View>
    );
    const sendDisc = (
      <View pointerEvents="none">
        <AgentInputSubmitButton
          testID="composer-placement-preview.send"
          disabled
          hasSendableContent={false}
          dictationStatus="idle"
          onSend={NOOP}
        />
      </View>
    );
    return (
      <View
        testID={props.testID ?? 'composer-placement-preview'}
        accessibilityLabel={t('navigationPlacement.preview')}
        // A picture of the composer, not a second set of controls: assistive tech reads the list below it.
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        // Only chips take presses, to be grabbed; a phone's one-line row still scrolls under the finger.
        pointerEvents={phone || canReorder ? 'box-none' : 'none'}
        style={[resolveAgentInputPanelStyle(theme), { gap: theme.space.s4 }]}
      >
        <View testID="composer-placement-preview.field" pointerEvents="none"
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s8, minHeight: 36, paddingHorizontal: theme.space.s6, paddingTop: theme.space.s4 }}>
          <Text variant="reading" numberOfLines={1} style={{ flex: 1, minWidth: 0, color: tint }}>{props.placeholder ?? t('session.inputPlaceholder')}</Text>
          {accessories.map((descriptor) =>
            descriptor.icon ? (
              <View key={descriptor.id} testID={`composer-placement-preview.accessory:${descriptor.id}`}>
                <Icon name={descriptor.icon} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={theme.colors.text.secondary} />
              </View>
            ) : null,
          )}
        </View>
        {phone ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
            {menuTrigger}
            {/* One line that scrolls sideways, through the live row's own scroller and edge fades (ACCEPT-OPUS). */}
            <AgentInputScrollableChipRow
              fadeColor={theme.colors.surface.selected}
              indicatorColor={tint}
              containerStyle={PHONE_ROW_STYLE}
              contentStyle={phoneRowContentStyle}
              fadeLeftStyle={FADE_LEFT_STYLE}
              fadeRightStyle={FADE_RIGHT_STYLE}
            >
              {chips.map(renderChip)}
            </AgentInputScrollableChipRow>
            {sendDisc}
          </View>
        ) : (
          <View style={{ gap: theme.space.s2 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s2 }}>
              {menuTrigger}
              <View style={{ flex: 1, minWidth: 0 }}>{chipLine('primary', primaryChips)}</View>
              {secondaryChips.length > 0 ? null : sendDisc}
            </View>
            {secondaryChips.length > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s2 }}>
                <View style={{ flex: 1, minWidth: 0 }}>{chipLine('secondary', secondaryChips)}</View>
                {sendDisc}
              </View>
            ) : null}
          </View>
        )}
      </View>
    );
  },
);
