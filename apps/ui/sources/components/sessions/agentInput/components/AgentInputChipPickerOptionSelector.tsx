import React from "react";
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Typography } from "@/constants/Typography";
import { Text } from "@/components/ui/text/Text";
import { normalizeNodeForView } from "@/components/ui/rendering/normalizeNodeForView";
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { AgentInputChipPickerTopSelector } from "./AgentInputChipPickerTopSelector";
import {
  AGENT_INPUT_CHIP_PICKER_OPTION_ROW_RADIUS,
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

const RAIL_ACTION_SIZE = 20;
const PICKER_OPTION_TOUCH_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);

type WebHoverablePressableState = Readonly<{
  pressed: boolean;
  hovered?: boolean;
}>;

type WebClickableViewProps = React.ComponentPropsWithRef<typeof View> & {
  onClick?: (event?: unknown) => void;
  onKeyDown?: (event: {
    key?: string;
    preventDefault?: () => void;
    stopPropagation?: () => void;
    nativeEvent?: { stopPropagation?: () => void };
  }) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  tabIndex?: number;
};

const WebClickableView = View as unknown as React.ComponentType<WebClickableViewProps>;

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

type WebPressableProps = React.ComponentPropsWithRef<typeof Pressable> & {
  "aria-pressed"?: boolean;
};

const WebPressable = Pressable as unknown as React.ComponentType<WebPressableProps>;

export type AgentInputChipPickerOptionSelectorProps = Readonly<{
  sections: ReadonlyArray<AgentInputChipPickerOptionSection>;
  focusedOptionId: string | null;
  selectedOptionId?: string | null;
  onFocusOption: (optionId: string) => void;
  variant: "rail" | "stacked";
}>;

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
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const selectedIndicatorColor = theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background;
  const transientStyles = React.useMemo(() => ({
    ...createAgentInputChipPickerOptionTransientStyles(theme),
    optionRowCompact: {
      minHeight: PICKER_OPTION_TOUCH_TARGET_SIZE,
      paddingVertical: 6,
    },
  }), [theme]);

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

  return (
    <View
      testID="agent-input-chip-picker.option-rail"
      style={styles.railContainer}
    >
      {props.sections.map((section) => (
        <View key={section.id} style={styles.sectionBlock}>
          {section.label ? (
            <Text style={styles.sectionTitle}>{section.label}</Text>
          ) : null}
          <View style={styles.railOptionsColumn}>
            {section.options.map((option) => (
              <AgentInputChipPickerOptionButton
                key={option.id}
                option={option}
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
  const shouldRenderRailAction = Platform.OS === "web" && Boolean(props.option.railAction);
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
  const buildOptionRowStyle = (state: WebHoverablePressableState) => {
    const { pressed } = state;
    // RN Web exposes `hovered` in the Pressable state callback, but `react-native` types do not model it.
    const stateHovered = state.hovered === true;
    const rowHovered = hovered || stateHovered;
    return [
      styles.optionRow,
      props.compact ? props.transientStyles.optionRowCompact : null,
      Platform.OS === "web"
        && rowHovered
        && !props.focused
        && !disabled
        && !props.option.muted
        ? props.transientStyles.optionRowHovered
        : null,
      props.focused ? props.transientStyles.optionRowFocused : null,
      pressed ? props.transientStyles.optionRowPressed : null,
      (disabled || props.option.muted) ? props.transientStyles.optionRowDisabled : null,
    ];
  };
  const activateFromWebEvent = (event?: unknown) => {
    const maybeEvent = event as {
      stopPropagation?: () => void;
      nativeEvent?: { stopPropagation?: () => void };
    } | undefined;
    try { maybeEvent?.stopPropagation?.(); } catch {}
    try { maybeEvent?.nativeEvent?.stopPropagation?.(); } catch {}
    if (disabled) return;
    props.onPress();
  };

  const content = (
    <>
      <View style={styles.optionLeft}>
        {props.option.icon ? normalizeAgentInputChipPickerOptionIcon(props.option.icon) : null}
        <View style={styles.optionTextBlock}>
          <Text style={[styles.optionLabel, props.focused ? styles.optionLabelFocused : null]}>{props.option.label}</Text>
          {shouldShowSubtitle ? (
            <Text style={styles.optionSubtitle}>{normalizedSubtitle}</Text>
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
          normalizeNodeForView(props.option.statusMarker)
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
        <WebClickableView
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel={resolveAgentInputChipPickerOptionAccessibilityLabel(props.option, props.selected)}
          accessibilityState={{
            disabled,
            selected: props.selected,
          }}
          onClick={activateFromWebEvent}
          onKeyDown={(event) => {
            const key = String(event?.key ?? "");
            if (key !== "Enter" && key !== " ") return;
            event?.preventDefault?.();
            activateFromWebEvent(event);
          }}
          tabIndex={disabled ? -1 : 0}
          style={buildOptionRowStyle({ pressed: false })}
        >
          {content}
        </WebClickableView>
        {props.option.railAction ? (
          <WebPressable
            testID={props.option.railAction.testID}
            accessibilityRole="button"
            accessibilityLabel={props.option.railAction.accessibilityLabel}
            accessibilityState={{
              disabled: railActionDisabled,
              selected: props.option.railAction.selected === true,
            }}
            aria-pressed={props.option.railAction.selected === true}
            disabled={railActionDisabled}
            hitSlop={4}
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
          </WebPressable>
        ) : null}
      </WebRailRowContainer>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={resolveAgentInputChipPickerOptionAccessibilityLabel(props.option, props.selected)}
      accessibilityState={{
        disabled,
        selected: props.selected,
      }}
      disabled={disabled}
      onPress={() => {
        if (disabled) return;
        props.onPress();
      }}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={(state) => buildOptionRowStyle(state as WebHoverablePressableState)}
    >
      {content}
    </Pressable>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  railContainer: {
    width: "100%",
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: theme.colors.background.canvas,
  },
  sectionBlock: {
    gap: 4,
    marginBottom: 10,
  },
  sectionTitle: {
    paddingHorizontal: 6,
    fontSize: 12,
    color: theme.colors.text.secondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    ...Typography.header(),
  },
  railOptionsColumn: {
    gap: 6,
  },
  optionRow: {
    minHeight: PICKER_OPTION_TOUCH_TARGET_SIZE,
    borderRadius: AGENT_INPUT_CHIP_PICKER_OPTION_ROW_RADIUS,
    borderWidth: 0,
    paddingHorizontal: 8,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    backgroundColor: "transparent",
  },
  optionRowContainer: {
    position: "relative",
  },
  optionLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  optionTextBlock: {
    flex: 1,
    gap: 0,
  },
  optionRight: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6,
  },
  railAction: {
    width: RAIL_ACTION_SIZE,
    height: RAIL_ACTION_SIZE,
    alignItems: "center",
    justifyContent: "center",
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
