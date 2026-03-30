import React from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { shadowLevelStyle } from "@/shadowElevation";
import { Typography } from "@/constants/Typography";
import { Text } from "@/components/ui/text/Text";
import { normalizeNodeForView } from "@/components/ui/rendering/normalizeNodeForView";
import { AgentInputChipPickerTopSelector } from "./AgentInputChipPickerTopSelector";

import type {
  AgentInputChipPickerOption,
  AgentInputChipPickerOptionSection,
} from "./AgentInputChipPickerTypes";

export type AgentInputChipPickerOptionSelectorProps = Readonly<{
  sections: ReadonlyArray<AgentInputChipPickerOptionSection>;
  focusedOptionId: string | null;
  selectedOptionId?: string | null;
  onFocusOption: (optionId: string) => void;
  variant: "rail" | "stacked";
}>;

export function AgentInputChipPickerOptionSelector(
  props: AgentInputChipPickerOptionSelectorProps,
) {
  const { theme } = useUnistyles();
  const styles = stylesheet;

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
                checkColor={theme.colors.button.primary.background}
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
  onPress: () => void;
}>;

function AgentInputChipPickerOptionButton(
  props: AgentInputChipPickerOptionButtonProps,
) {
  const styles = stylesheet;
  const testID = `agent-input-chip-picker.option:${props.option.id}`;
  const normalizedSubtitle = props.option.subtitle?.trim();
  const shouldShowSubtitle =
    !props.compact &&
    Boolean(normalizedSubtitle) &&
    normalizedSubtitle?.toLowerCase() !== props.option.label.trim().toLowerCase();

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={props.option.label}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.optionRow,
        props.compact ? styles.optionRowCompact : null,
        props.focused ? styles.optionRowFocused : null,
        pressed ? styles.optionRowPressed : null,
        (props.option.disabled || props.option.muted) ? styles.optionRowDisabled : null,
      ]}
    >
      <View style={styles.optionLeft}>
        {props.option.icon ? (
          <View style={styles.optionIcon}>
            {normalizeNodeForView(props.option.icon)}
          </View>
        ) : null}
        <View style={styles.optionTextBlock}>
          <Text style={styles.optionLabel}>{props.option.label}</Text>
          {shouldShowSubtitle ? (
            <Text style={styles.optionSubtitle}>{normalizedSubtitle}</Text>
          ) : null}
        </View>
      </View>
      <Ionicons
        name="checkmark-outline"
        size={14}
        color={props.checkColor}
        style={props.selected ? null : { opacity: 0 }}
      />
    </Pressable>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  railContainer: {
    width: "100%",
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: theme.colors.groupped.background,
  },
  sectionBlock: {
    gap: 4,
    marginBottom: 10,
  },
  sectionTitle: {
    paddingHorizontal: 6,
    fontSize: 12,
    color: theme.colors.groupped.sectionTitle,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    ...Typography.header(),
  },
  railOptionsColumn: {
    gap: 6,
  },
  optionRow: {
    minHeight: 36,
    borderRadius: 12,
    borderWidth: 0,
    paddingHorizontal: 8,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    backgroundColor: "transparent",
  },
  optionRowCompact: {
    minHeight: 44,
    paddingVertical: 6,
  },
  optionRowFocused: {
    backgroundColor: theme.colors.surface,
    ...shadowLevelStyle(theme.colors.shadowLevels[1]),
  },
  optionRowPressed: {
    opacity: 0.82,
  },
  optionRowDisabled: {
    opacity: 0.45,
  },
  optionLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  optionIcon: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  optionTextBlock: {
    flex: 1,
    gap: 0,
  },
  optionLabel: {
    fontSize: 13,
    lineHeight: 15,
    color: theme.colors.text,
    ...Typography.default("semiBold"),
  },
  optionSubtitle: {
    marginTop: 1,
    fontSize: 11,
    lineHeight: 14,
    color: theme.colors.textTertiary,
  },
}));
