import * as React from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet } from "react-native-unistyles";

import { Popover } from "@/components/ui/popover";
import { Text } from "@/components/ui/text/Text";

import { AgentInputPopoverSurface } from "./AgentInputPopoverSurface";
import type { AgentInputChipPickerOption } from "./AgentInputChipPickerTypes";

export type AgentInputSimpleOptionsPopoverProps = Readonly<{
  open: boolean;
  anchorRef: React.RefObject<any>;
  title: string;
  options: ReadonlyArray<AgentInputChipPickerOption>;
  selectedOptionId?: string | null;
  onSelect: (id: string) => void;
  onRequestClose: () => void;
  maxHeightCap?: number;
  maxWidthCap?: number;
}>;

export function AgentInputSimpleOptionsPopover(
  props: AgentInputSimpleOptionsPopoverProps,
) {
  return (
    <Popover
      open={props.open}
      anchorRef={props.anchorRef}
      boundaryRef={null}
      placement="top"
      gap={8}
      maxHeightCap={props.maxHeightCap ?? 360}
      maxWidthCap={props.maxWidthCap ?? 320}
      closeOnAnchorPress={false}
      portal={{
        web: { target: "body" },
        native: true,
        matchAnchorWidth: false,
        anchorAlign: "start",
      }}
      onRequestClose={props.onRequestClose}
      backdrop={{ style: { backgroundColor: "transparent" } }}
      containerStyle={{ paddingHorizontal: 0 }}
    >
      {({ maxHeight }) => (
        <AgentInputPopoverSurface
          testID="agent-input-simple-options-popover"
          maxHeight={maxHeight}
          scrollEnabled
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.content}>
            <Text style={styles.title}>{props.title}</Text>

            {props.options.map((option) => {
              const isSelected = option.id === props.selectedOptionId;
              return (
                <Pressable
                  key={option.id}
                  testID={`agent-input-simple-option:${option.id}`}
                  onPress={() => props.onSelect(option.id)}
                  style={({ pressed }) => [
                    styles.optionRow,
                    isSelected ? styles.optionRowSelected : null,
                    pressed ? styles.optionRowPressed : null,
                  ]}
                >
                  <View style={styles.optionTextWrap}>
                    <Text style={styles.optionLabel}>{option.label}</Text>
                    {option.subtitle ? (
                      <Text style={styles.optionSubtitle}>
                        {option.subtitle}
                      </Text>
                    ) : null}
                  </View>
                  {isSelected ? (
                    <Ionicons
                      name="checkmark"
                      size={18}
                      style={styles.checkIcon}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </AgentInputPopoverSurface>
      )}
    </Popover>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
    minWidth: 240,
  },
  title: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: theme.colors.textSecondary,
    marginBottom: 4,
  },
  optionRow: {
    minHeight: 40,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.surface,
  },
  optionRowSelected: {
    backgroundColor: theme.colors.surfaceSelected,
  },
  optionRowPressed: {
    opacity: 0.82,
  },
  optionTextWrap: {
    flex: 1,
    flexShrink: 1,
    gap: 2,
  },
  optionLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.text,
  },
  optionSubtitle: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.textSecondary,
  },
  checkIcon: {
    color: theme.colors.radio.active,
  },
}));
