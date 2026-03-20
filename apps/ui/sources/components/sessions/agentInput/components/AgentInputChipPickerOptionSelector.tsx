import React from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Typography } from "@/constants/Typography";
import { Text } from "@/components/ui/text/Text";
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
                  if (option.disabled) return;
                  props.onFocusOption(option.id);
                }}
                checkColor={theme.colors.status.connected}
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

  return (
    <Pressable
      testID={`agent-input-chip-picker.option:${props.option.id}`}
      accessibilityRole="button"
      disabled={props.option.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.optionRow,
        props.compact ? styles.optionRowCompact : null,
        props.focused ? styles.optionRowFocused : null,
        pressed ? styles.optionRowPressed : null,
        props.option.disabled ? styles.optionRowDisabled : null,
      ]}
    >
      <View style={styles.optionTextBlock}>
        <Text style={styles.optionLabel}>{props.option.label}</Text>
        {props.option.subtitle && !props.compact ? (
          <Text style={styles.optionSubtitle}>{props.option.subtitle}</Text>
        ) : null}
      </View>
      {props.selected ? (
        <Ionicons name="checkmark" size={18} color={props.checkColor} />
      ) : null}
    </Pressable>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  railContainer: {
    width: 220,
    maxWidth: "40%",
    paddingRight: 2,
  },
  sectionBlock: {
    gap: 6,
    marginBottom: 12,
  },
  sectionTitle: {
    paddingHorizontal: 4,
    fontSize: 11,
    color: theme.colors.groupped.sectionTitle,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    ...Typography.header(),
  },
  railOptionsColumn: {
    gap: 6,
  },
  optionRow: {
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderColor: "transparent",
  },
  optionRowCompact: {
    minHeight: 36,
    paddingVertical: 6,
  },
  optionRowFocused: {
    borderColor: theme.colors.button.primary.background,
    backgroundColor: theme.colors.surfaceSelected,
  },
  optionRowPressed: {
    opacity: 0.82,
  },
  optionRowDisabled: {
    opacity: 0.45,
  },
  optionTextBlock: {
    flex: 1,
    gap: 1,
  },
  optionLabel: {
    fontSize: 13,
    color: theme.colors.text,
    ...Typography.default("semiBold"),
  },
  optionSubtitle: {
    fontSize: 11,
    color: theme.colors.textSecondary,
  },
}));
