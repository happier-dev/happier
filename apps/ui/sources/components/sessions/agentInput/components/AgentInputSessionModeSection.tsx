import * as React from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

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
  const { theme } = useUnistyles();
  const selectedIndicatorColor = theme.dark ? theme.colors.text.primary : theme.colors.button.primary.background;

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
            <Text style={styles.summaryText}>{props.summary}</Text>
          ) : (
            props.summary
          )}
        </View>
      ) : null}

      <View style={styles.cardsGrid}>
        {props.options.map((option) => {
          const selected = props.selectedOptionId === option.id;
          const hasDescription =
            typeof option.description === "string" &&
            option.description.trim().length > 0;

          return (
            <Pressable
              key={option.id}
              testID={`agent-input-session-mode-option:${option.id}`}
              accessibilityRole="radio"
              accessibilityLabel={option.name}
              accessibilityState={{ selected }}
              onPress={() => props.onSelectOption?.(option.id)}
              style={({ pressed }) => [
                styles.optionCard,
                props.options.length === 1 ? styles.optionCardFullWidth : null,
                selected ? styles.optionCardSelected : null,
                pressed ? styles.optionCardPressed : null,
              ]}
            >
              <View style={styles.optionCardHeader}>
                <Text
                  numberOfLines={hasDescription ? 2 : 1}
                  style={styles.optionCardTitle}
                >
                  {option.name}
                </Text>
                <View style={styles.optionCardIndicator}>
                  {selected ? (
                    <Ionicons
                      name="checkmark-circle"
                      size={18}
                      color={selectedIndicatorColor}
                    />
                  ) : null}
                </View>
              </View>
              {hasDescription ? (
                <Text style={styles.optionCardDescription}>
                  {option.description}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: 4,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  headerAccessory: {
    flexShrink: 0,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.colors.text.secondary,
  },
  summaryRow: {
    minHeight: 0,
  },
  summaryText: {
    fontSize: 10,
    lineHeight: 13,
    color: theme.colors.text.secondary,
  },
  cardsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
  },
  optionCard: {
    width: "48.5%",
    minHeight: 52,
    borderRadius: 13,
    paddingHorizontal: 9,
    paddingVertical: 7,
    backgroundColor: theme.colors.surface.base,
    gap: 2,
  },
  optionCardFullWidth: {
    width: "100%",
  },
  optionCardSelected: {
    backgroundColor: theme.colors.surface.pressed,
  },
  optionCardPressed: {
    opacity: 0.86,
  },
  optionCardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 4,
  },
  optionCardTitle: {
    flex: 1,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700",
    color: theme.colors.text.primary,
  },
  optionCardIndicator: {
    minWidth: 16,
    minHeight: 16,
    alignItems: "flex-end",
    justifyContent: "flex-start",
  },
  optionCardDescription: {
    fontSize: 10,
    lineHeight: 12,
    color: theme.colors.text.secondary,
  },
}));
