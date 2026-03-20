import React from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { Typography } from "@/constants/Typography";
import { Text } from "@/components/ui/text/Text";

import type { AgentInputChipPickerOption } from "./AgentInputChipPickerTypes";

export type AgentInputChipPickerDetailPaneProps = Readonly<{
  option: AgentInputChipPickerOption;
  onApply: () => void;
  applyLabel: string;
}>;

export function AgentInputChipPickerDetailPane(
  props: AgentInputChipPickerDetailPaneProps,
) {
  const styles = stylesheet;
  const detailContent = props.option.renderDetailContent
    ? props.option.renderDetailContent()
    : props.option.detailContent;

  return (
    <View style={styles.detailPane}>
      {props.option.detailDescription ? (
        <Text style={styles.detailDescription}>
          {props.option.detailDescription}
        </Text>
      ) : null}

      {detailContent ? (
        <View style={styles.detailCustomContent}>{detailContent}</View>
      ) : null}

      {(props.option.detailBullets?.length ?? 0) > 0 ? (
        <View style={styles.detailBullets}>
          {props.option.detailBullets?.map((bullet, index) => (
            <View key={`${bullet}-${index}`} style={styles.detailBulletRow}>
              <View style={styles.detailBulletDot} />
              <Text style={styles.detailBulletText}>{bullet}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {props.option.detailActionLabel && props.option.onDetailAction ? (
        <Pressable
          testID="agent-input-chip-picker.detail-action"
          accessibilityRole="button"
          onPress={props.option.onDetailAction}
          disabled={props.option.disabled}
          style={({ pressed }) => [
            styles.detailActionButton,
            pressed ? styles.detailActionButtonPressed : null,
            props.option.disabled ? styles.applyButtonDisabled : null,
          ]}
        >
          <Text style={styles.detailActionButtonText}>
            {props.option.detailActionLabel}
          </Text>
        </Pressable>
      ) : null}

      <Pressable
        testID="agent-input-chip-picker.apply"
        accessibilityRole="button"
        onPress={props.onApply}
        disabled={props.option.disabled}
        style={({ pressed }) => [
          styles.applyButton,
          pressed ? styles.applyButtonPressed : null,
          props.option.disabled ? styles.applyButtonDisabled : null,
        ]}
      >
        <Text style={styles.applyButtonText}>{props.applyLabel}</Text>
      </Pressable>
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  detailPane: {
    flex: 1,
    gap: 10,
  },
  detailHeader: {
    gap: 3,
  },
  detailTitle: {
    fontSize: 15,
    ...Typography.header(),
    color: theme.colors.text,
  },
  detailSubtitle: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  detailDescription: {
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.text,
  },
  detailCustomContent: {
    gap: 10,
  },
  detailBullets: {
    gap: 8,
  },
  detailBulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  detailBulletDot: {
    width: 6,
    height: 6,
    marginTop: 7,
    borderRadius: 999,
    backgroundColor: theme.colors.textSecondary,
  },
  detailBulletText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    color: theme.colors.textSecondary,
  },
  detailActionButton: {
    minHeight: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.divider,
    backgroundColor: theme.colors.surfaceHigh,
    paddingHorizontal: 12,
  },
  detailActionButtonPressed: {
    opacity: 0.82,
  },
  detailActionButtonText: {
    color: theme.colors.text,
    ...Typography.header(),
    fontSize: 13,
  },
  applyButton: {
    marginTop: "auto",
    minHeight: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.button.primary.background,
    paddingHorizontal: 12,
  },
  applyButtonPressed: {
    opacity: 0.82,
  },
  applyButtonDisabled: {
    opacity: 0.5,
  },
  applyButtonText: {
    color: theme.colors.button.primary.tint,
    ...Typography.header(),
    fontSize: 13,
  },
}));
