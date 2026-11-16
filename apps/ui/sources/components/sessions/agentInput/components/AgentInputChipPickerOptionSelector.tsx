import React from "react";
import { Platform, View } from 'react-native';
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Typography } from "@/constants/Typography";
import { Text } from "@/components/ui/text/Text";
import { normalizeNodeForView } from "@/components/ui/rendering/normalizeNodeForView";
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { AgentInputChipPickerTopSelector } from "./AgentInputChipPickerTopSelector";
import { MENU_ROW_METRICS, MENU_ROW_SHAPE } from '@/components/ui/lists/itemDensityMetrics';
import {
  createAgentInputChipPickerOptionTransientStyles,
  type AgentInputChipPickerOptionTransientStyles,
} from "./agentInputChipPickerOptionStyles";
import { normalizeAgentInputChipPickerOptionIcon } from "./agentInputChipPickerOptionIcon";
import { Icon } from '@/components/ui/icons/Icon';

import { resolveAgentInputChipPickerOptionAccessibilityLabel } from "./AgentInputChipPickerTypes";
import type {
  AgentInputChipPickerOption,
  AgentInputChipPickerOptionSection,
} from "./AgentInputChipPickerTypes";
import { HappierPressable, type HappierFocusable } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { useAgentInputChipPickerRovingFocus, type AgentInputChipPickerRovingFocus } from './useAgentInputChipPickerRovingFocus';

const RAIL_ACTION_SIZE = 20;
// An option row is control-height under every pointer; the row is a full-width target in a list.
const PICKER_OPTION_ROW_MIN_HEIGHT = HAPPIER_PAGE_METRICS.controlHeightPx;

type WebHoverablePressableState = Readonly<{
  pressed: boolean;
  hovered?: boolean;
  focused?: boolean;
}>;

type WebRailRowContainerProps = React.ComponentPropsWithRef<typeof View> & {
  onFocus?: (event: { currentTarget?: { contains?: (target: unknown) => boolean } }) => void;
  onBlur?: (event: {
    currentTarget?: { contains?: (target: unknown) => boolean };
    relatedTarget?: unknown;
  }) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

const WebRailRowContainer = View as unknown as React.ComponentType<WebRailRowContainerProps>;

export type AgentInputChipPickerOptionSelectorProps = Readonly<{
  sections: ReadonlyArray<AgentInputChipPickerOptionSection>;
  focusedOptionId: string | null;
  selectedOptionId?: string | null;
  onFocusOption: (optionId: string) => void;
  variant: "rail" | "stacked";
}>;

/** Rail rows draw their trailing action (such as the Agent favorite) only where hover and focus reveal it. */
export function agentInputChipPickerRailActionsRender(): boolean {
  return Platform.OS === "web";
}

export function shouldShowAgentInputChipPickerRailAction(params: Readonly<{
  canRender: boolean;
  hovered: boolean;
  focused: boolean;
}>): boolean {
  return params.canRender && (params.hovered || params.focused);
}

export function AgentInputChipPickerOptionSelector(
  props: AgentInputChipPickerOptionSelectorProps,
) {
  if (props.variant === "stacked") {
    return (
      <AgentInputChipPickerTopSelector
        sections={props.sections}
        focusedOptionId={props.focusedOptionId}
        selectedOptionId={props.selectedOptionId ?? null}
        onFocusOption={props.onFocusOption}
      />
    );
  }
  return <AgentInputChipPickerRail {...props} />;
}

function AgentInputChipPickerRail(props: AgentInputChipPickerOptionSelectorProps) {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const selectedIndicatorColor = theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background;
  const transientStyles = React.useMemo(() => ({
    ...createAgentInputChipPickerOptionTransientStyles(theme),
    optionRowCompact: {
      minHeight: PICKER_OPTION_ROW_MIN_HEIGHT,
      paddingVertical: theme.space.s6,
    },
  }), [theme]);
  const railOptions = React.useMemo(
    () => props.sections.flatMap((section) => section.options),
    [props.sections],
  );
  const roving = useAgentInputChipPickerRovingFocus({
    options: railOptions,
    currentOptionId: props.focusedOptionId ?? props.selectedOptionId ?? null,
  });

  return (
    <View
      testID="agent-input-chip-picker.option-rail"
      style={styles.railContainer}
    >
      {props.sections.map((section, index) => (
        // A labelled group that follows another ("Not on devbox yet") starts after a hairline, like the stacked
        // selector's divider (lab agent-setup E1p), so its heading reads as a new group, never the row above's caption.
        <View key={section.id} style={[styles.sectionBlock, index > 0 && section.label ? styles.labelledGroup : null]}
          testID={index > 0 && section.label ? `agent-input-chip-picker.rail-group:${section.id}` : undefined}>
          {section.label ? (
            <Text style={styles.sectionTitle}>{section.label}</Text>
          ) : null}
          <View style={styles.railOptionsColumn}>
            {section.options.map((option) => (
              <AgentInputChipPickerOptionButton
                key={option.id}
                option={option}
                rovingIndex={railOptions.indexOf(option)}
                roving={roving}
                focusRingColor={theme.colors.border.focus}
                focused={props.focusedOptionId === option.id}
                selected={props.selectedOptionId === option.id}
                compact={false}
                onPress={() => {
                  props.onFocusOption(option.id);
                }}
                checkColor={selectedIndicatorColor}
                transientStyles={transientStyles}
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

type AgentInputChipPickerOptionButtonProps = Readonly<{
  option: AgentInputChipPickerOption;
  focused: boolean;
  selected: boolean;
  compact: boolean;
  checkColor: string;
  transientStyles: AgentInputChipPickerOptionSelectorTransientStyles;
  rovingIndex: number;
  roving: AgentInputChipPickerRovingFocus;
  focusRingColor: string;
  onPress: () => void;
}>;

type AgentInputChipPickerOptionSelectorTransientStyles = Readonly<{
  optionRowCompact: Readonly<{
    minHeight: number;
    paddingVertical: number;
  }>;
}> & AgentInputChipPickerOptionTransientStyles;

function AgentInputChipPickerOptionButton(
  props: AgentInputChipPickerOptionButtonProps,
) {
  const styles = stylesheet;
  const testID = `agent-input-chip-picker.option:${props.option.id}`;
  const disabled = props.option.disabled === true;
  const normalizedSubtitle = props.option.subtitle?.trim();
  const [hovered, setHovered] = React.useState(false);
  const [focusWithin, setFocusWithin] = React.useState(false);
  const shouldShowSubtitle =
    !props.compact &&
    Boolean(normalizedSubtitle) &&
    normalizedSubtitle?.toLowerCase() !== props.option.label.trim().toLowerCase();
  const shouldRenderRailAction = agentInputChipPickerRailActionsRender() && Boolean(props.option.railAction);
  const shouldShowRailAction = shouldShowAgentInputChipPickerRailAction({
    canRender: shouldRenderRailAction,
    hovered,
    focused: props.focused || focusWithin,
  });
  const railActionDisabled =
    !shouldShowRailAction
    || disabled
    || props.option.muted === true
    || props.option.railAction?.disabled === true;
  const { roving, rovingIndex } = props;
  const registerTarget = React.useCallback(
    (target: HappierFocusable | null) => roving.registerTarget(rovingIndex, target),
    [roving, rovingIndex],
  );
  const onRovingKeyDown = React.useCallback((key: string) => roving.onKeyDown(rovingIndex, key), [roving, rovingIndex]);
  const buildOptionRowStyle = (state: WebHoverablePressableState) => {
    const { pressed } = state;
    const rowHovered = hovered || state.hovered === true;
    return [
      styles.optionRow,
      Platform.OS === "web" && !disabled ? styles.optionRowInteractive : null,
      props.compact ? props.transientStyles.optionRowCompact : null,
      Platform.OS === "web"
        && rowHovered
        && !props.focused
        && !disabled
        ? props.transientStyles.optionRowHovered
        : null,
      props.focused ? props.transientStyles.optionRowFocused : null,
      pressed ? props.transientStyles.optionRowPressed : null,
      (disabled || props.option.muted) ? props.transientStyles.optionRowDisabled : null,
      focusRingStyle({ focused: state.focused === true, color: props.focusRingColor }),
    ];
  };

  const statusAction = !props.selected && props.option.statusMarker ? props.option.statusAction : undefined;
  const renderStatusAction = (action: NonNullable<AgentInputChipPickerOption["statusAction"]>, overlay?: true) => (
    <HappierPressable
      testID={action.testID}
      accessibilityRole="button"
      accessibilityLabel={action.accessibilityLabel}
      // Over the row, whose own press is the row: the mark keeps its drawn box.
      hitReach={0}
      onPress={(event) => {
        event?.stopPropagation?.();
        action.onPress();
        if (!disabled) props.onPress();
      }}
      style={[styles.statusAction, overlay ? styles.statusActionOverlay : null]}
    >
      {overlay ? null : normalizeNodeForView(props.option.statusMarker)}
    </HappierPressable>
  );
  const content = (
    <>
      <View style={styles.optionLeft}>
        {props.option.icon ? normalizeAgentInputChipPickerOptionIcon(props.option.icon) : null}
        <View style={styles.optionTextBlock}>
          {/* One line each: a rail row is a name to tap, and a wrapped name ("Qwen / Code") breaks the rail's rhythm. */}
          <Text numberOfLines={1} style={[styles.optionLabel, props.focused ? styles.optionLabelFocused : null]}>{props.option.label}</Text>
          {shouldShowSubtitle ? (
            <Text numberOfLines={1} style={styles.optionSubtitle}>{normalizedSubtitle}</Text>
          ) : null}
        </View>
      </View>
      <View style={styles.optionRight}>
        {shouldRenderRailAction ? <View style={styles.railAction} /> : null}
        {/*
          * One indicator slot, three states: the checkmark for the selection; the
          * producer's state mark for a row that is not the selection but is still
          * the one in use; an invisible checkmark otherwise, so every label in the
          * rail keeps the same width whatever the row is doing.
          */}
        {!props.selected && props.option.statusMarker ? (
          // In the rail the mark's operation is an overlay beside the row button (one button may not hold another).
          statusAction && !shouldRenderRailAction ? renderStatusAction(statusAction) : normalizeNodeForView(props.option.statusMarker)
        ) : (
          <Icon
            name="check"
            size={14}
            color={props.checkColor}
            style={props.selected ? null : { opacity: 0 }}
          />
        )}
      </View>
    </>
  );

  // The rail's one option row, on every platform: its press shows the Agent, and on the web it takes part in the
  // rail's roving focus (one Tab stop, arrows along the rail) and draws the focus ring.
  const row = (
    <HappierPressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={resolveAgentInputChipPickerOptionAccessibilityLabel(props.option, props.selected)}
      selected={props.selected}
      disabled={disabled}
      tabIndex={roving.tabIndexFor(rovingIndex)}
      controlRef={registerTarget}
      onKeyDown={onRovingKeyDown}
      onPress={() => {
        if (disabled) return;
        props.onPress();
      }}
      style={(state) => buildOptionRowStyle(state)}
    >
      {content}
    </HappierPressable>
  );

  if (shouldRenderRailAction) {
    return (
      <WebRailRowContainer
        style={styles.optionRowContainer}
        onFocus={() => setFocusWithin(true)}
        onBlur={(event) => {
          const relatedTarget = (event as { relatedTarget?: unknown }).relatedTarget;
          const currentTarget = event.currentTarget as unknown as {
            contains?: (target: unknown) => boolean;
          };
          if (currentTarget?.contains?.(relatedTarget)) return;
          setFocusWithin(false);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {row}
        {props.option.railAction ? (
          <HappierPressable
            testID={props.option.railAction.testID}
            accessibilityRole="button"
            accessibilityLabel={props.option.railAction.accessibilityLabel}
            selected={props.option.railAction.selected === true}
            disabled={railActionDisabled}
            // Overlaid on the option row, whose own press is the row: the action keeps its drawn box.
            hitReach={0}
            onPress={(event) => {
              event?.stopPropagation?.();
              if (railActionDisabled) return;
              props.option.railAction?.onPress();
            }}
            style={[
              styles.railAction,
              styles.railActionOverlay,
              shouldShowRailAction ? null : styles.railActionHidden,
            ]}
          >
            {normalizeNodeForView(props.option.railAction.icon)}
          </HappierPressable>
        ) : null}
        {statusAction ? renderStatusAction(statusAction, true) : null}
      </WebRailRowContainer>
    );
  }

  return row;
}

const stylesheet = StyleSheet.create((theme) => ({
  // The Agent rail is a list picker: its rows take the menu's edge-to-edge highlight like every menu.
  // The panel's rail frame owns the rail's fill (its material); the list adds none of its own.
  railContainer: {
    width: "100%",
    paddingVertical: theme.space.s12,
  },
  sectionBlock: {
    gap: theme.space.s4,
    marginBottom: theme.space.s10,
  },
  labelledGroup: {
    paddingTop: theme.space.s10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  // Sentence-case group label ("Favorites", "Agents"): the same anatomy as every picker group.
  sectionTitle: {
    // On the rows' own text edge.
    paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
    ...Typography.variant('meta', 'medium'),
    color: theme.colors.text.secondary,
  },
  railOptionsColumn: {},
  optionRow: {
    minHeight: PICKER_OPTION_ROW_MIN_HEIGHT,
    borderWidth: 0,
    ...MENU_ROW_SHAPE,
    paddingVertical: theme.space.s6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space.s8,
    backgroundColor: "transparent",
  },
  // A rail row is a plain clickable View on web, which would otherwise keep the text cursor's arrow.
  optionRowInteractive: {
    cursor: "pointer",
  },
  optionRowContainer: {
    position: "relative",
  },
  optionLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s8,
  },
  optionTextBlock: {
    flex: 1,
    minWidth: 0,
    gap: 0,
  },
  optionRight: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.space.s6,
  },
  railAction: {
    width: RAIL_ACTION_SIZE,
    height: RAIL_ACTION_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  statusAction: {
    width: RAIL_ACTION_SIZE,
    height: RAIL_ACTION_SIZE,
    alignItems: "center",
    justifyContent: "center",
    // The mark keeps the indicator slot's width, so the row's label does not move.
    marginHorizontal: -((RAIL_ACTION_SIZE - 14) / 2),
  },
  // Centred on the indicator slot: the row's end padding plus half the 14 px mark.
  statusActionOverlay: {
    position: "absolute",
    marginHorizontal: 0,
    right: theme.space.s8 + 7 - RAIL_ACTION_SIZE / 2,
    top: "50%",
    transform: [{ translateY: -(RAIL_ACTION_SIZE / 2) }],
  },
  railActionOverlay: {
    position: "absolute",
    right: 28,
    top: "50%",
    transform: [{ translateY: -(RAIL_ACTION_SIZE / 2) }],
  },
  railActionHidden: {
    opacity: 0,
  },
  optionLabel: {
    fontSize: 14,
    lineHeight: 15,
    color: theme.colors.text.primary,
  },
  optionLabelFocused: {
    ...Typography.default("semiBold"),
  },
  optionSubtitle: {
    marginTop: 1,
    fontSize: 12,
    lineHeight: 14,
    color: theme.colors.text.tertiary,
  },
}));
