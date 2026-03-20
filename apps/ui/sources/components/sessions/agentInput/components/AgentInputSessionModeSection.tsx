import * as React from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { Text } from "@/components/ui/text/Text";
import { t } from "@/text";

export type AgentInputSessionModeOption = Readonly<{
  id: string;
  name: string;
  description?: string;
}>;

type AgentInputSessionModeSectionProps = Readonly<{
  options: ReadonlyArray<AgentInputSessionModeOption>;
  selectedOptionId: string;
  summary?: React.ReactNode;
  headerAccessory?: React.ReactNode;
  onSelectOption?: (optionId: string) => void;
}>;

export function AgentInputSessionModeSection(
  props: AgentInputSessionModeSectionProps,
) {
  if (props.options.length === 0) {
    return null;
  }

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <Text style={styles.sectionTitle}>
          {t("agentInput.mode.sectionTitle")}
        </Text>
        {props.headerAccessory ? (
          <View style={styles.headerAccessory}>{props.headerAccessory}</View>
        ) : null}
      </View>

      {props.summary ? (
        <View
          style={styles.summaryRow}
          testID="agent-input-session-mode-summary"
        >
          {typeof props.summary === "string" ? (
            <Text style={styles.optionDescription}>{props.summary}</Text>
          ) : (
            props.summary
          )}
        </View>
      ) : null}

      {props.options.map((option) => {
        const isSelected = props.selectedOptionId === option.id;
        return (
          <Pressable
            testID={`agent-input-session-mode-option:${option.id}`}
            key={option.id}
            onPress={() => props.onSelectOption?.(option.id)}
            style={({ pressed }) => [
              styles.optionRow,
              pressed ? styles.optionRowPressed : null,
            ]}
          >
            <View
              style={[
                styles.radioOuter,
                isSelected
                  ? styles.radioOuterSelected
                  : styles.radioOuterUnselected,
              ]}
            >
              {isSelected ? <View style={styles.radioInner} /> : null}
            </View>
            <View style={styles.optionContent}>
              <Text
                style={[
                  styles.optionLabel,
                  isSelected
                    ? styles.optionLabelSelected
                    : styles.optionLabelUnselected,
                ]}
              >
                {option.name}
              </Text>
              {option.description ? (
                <Text style={styles.optionDescription}>
                  {option.description}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: 10,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  headerAccessory: {
    flexShrink: 0,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: theme.colors.textSecondary,
  },
  summaryRow: {
    minHeight: 20,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.divider,
  },
  optionRowPressed: {
    opacity: 0.85,
  },
  radioOuter: {
    width: 16,
    height: 16,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
    borderWidth: 2,
  },
  radioOuterSelected: {
    borderColor: theme.colors.radio.active,
  },
  radioOuterUnselected: {
    borderColor: theme.colors.divider,
  },
  radioInner: {
    width: 4,
    height: 4,
    borderRadius: 999,
    backgroundColor: theme.colors.radio.active,
  },
  optionContent: {
    flex: 1,
    flexShrink: 1,
    gap: 4,
  },
  optionLabel: {
    fontSize: 15,
    fontWeight: "600",
  },
  optionLabelSelected: {
    color: theme.colors.text,
  },
  optionLabelUnselected: {
    color: theme.colors.text,
  },
  optionDescription: {
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.textSecondary,
  },
}));
