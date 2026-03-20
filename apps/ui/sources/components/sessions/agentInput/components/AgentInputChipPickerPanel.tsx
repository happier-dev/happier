import React from "react";
import { Pressable, useWindowDimensions, ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Typography } from "@/constants/Typography";
import { Item } from "@/components/ui/lists/Item";
import { ItemGroup } from "@/components/ui/lists/ItemGroup";
import { ItemListStatic } from "@/components/ui/lists/ItemList";
import { Text } from "@/components/ui/text/Text";
import { t } from "@/text";

import { AgentInputChipPickerDetailPane } from "./AgentInputChipPickerDetailPane";
import { AgentInputChipPickerOptionSelector } from "./AgentInputChipPickerOptionSelector";
import {
  agentInputChipPickerHasDetailPane,
  buildAgentInputChipPickerSections,
  type AgentInputChipPickerPanelProps,
} from "./AgentInputChipPickerTypes";

const DETAILED_PICKER_STACKED_WIDTH = 520;

export {
  type AgentInputChipPickerOption,
  type AgentInputChipPickerPanelProps,
} from "./AgentInputChipPickerTypes";

export function AgentInputChipPickerPanel(
  props: AgentInputChipPickerPanelProps,
) {
  const { width: windowWidth } = useWindowDimensions();
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const sections = React.useMemo(
    () => buildAgentInputChipPickerSections(props.options),
    [props.options],
  );
  const detailed = React.useMemo(
    () => agentInputChipPickerHasDetailPane(props.options),
    [props.options],
  );
  const [focusedOptionId, setFocusedOptionId] = React.useState<string | null>(
    props.selectedOptionId ?? props.options[0]?.id ?? null,
  );
  const previousSelectedOptionIdRef = React.useRef<string | null>(
    props.selectedOptionId ?? null,
  );

  React.useEffect(() => {
    const nextSelectedOptionId =
      props.selectedOptionId ?? props.options[0]?.id ?? null;
    const selectedOptionChanged =
      previousSelectedOptionIdRef.current !== (props.selectedOptionId ?? null);
    previousSelectedOptionIdRef.current = props.selectedOptionId ?? null;

    setFocusedOptionId((current) => {
      if (selectedOptionChanged) {
        return nextSelectedOptionId;
      }

      if (current && props.options.some((option) => option.id === current)) {
        return current;
      }

      return nextSelectedOptionId;
    });
  }, [props.options, props.selectedOptionId]);

  const focusedOption = React.useMemo(
    () =>
      props.options.find((option) => option.id === focusedOptionId) ??
      props.options[0] ??
      null,
    [focusedOptionId, props.options],
  );

  const detailedLayout =
    detailed && windowWidth < DETAILED_PICKER_STACKED_WIDTH
      ? "stacked"
      : "split";

  return (
    <View testID="agent-input-chip-picker" style={styles.container}>
      {!detailed ? (
        <ScrollView style={styles.body}>
          <Text style={styles.title}>{props.title}</Text>
          <ItemListStatic style={{ backgroundColor: "transparent" }}>
            {sections.map((section) => (
              <ItemGroup key={section.id} title={section.label ?? ""}>
                {section.options.map((option, index) => (
                  <Item
                    key={option.id}
                    testID={`agent-input-chip-picker.option:${option.id}`}
                    title={option.label}
                    subtitle={option.subtitle}
                    selected={props.selectedOptionId === option.id}
                    disabled={option.disabled}
                    showChevron={false}
                    showDivider={index < section.options.length - 1}
                    onPress={() => {
                      if (option.disabled) return;
                      props.onSelect(option.id);
                      props.onRequestClose();
                    }}
                  />
                ))}
              </ItemGroup>
            ))}
          </ItemListStatic>
        </ScrollView>
      ) : (
        <View
          style={[
            styles.body,
            styles.bodyDetailed,
            detailedLayout === "stacked" ? styles.bodyDetailedStacked : null,
          ]}
        >
          <AgentInputChipPickerOptionSelector
            sections={sections}
            focusedOptionId={focusedOption?.id ?? null}
            selectedOptionId={props.selectedOptionId}
            onFocusOption={setFocusedOptionId}
            variant={detailedLayout === "stacked" ? "stacked" : "rail"}
          />
          {focusedOption ? (
            <AgentInputChipPickerDetailPane
              option={focusedOption}
              onApply={() => {
                if (focusedOption.disabled) return;
                if (focusedOption.onApply) {
                  focusedOption.onApply();
                } else {
                  props.onSelect(focusedOption.id);
                }
                props.onRequestClose();
              }}
              applyLabel={props.applyLabel ?? t("common.use")}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    width: "100%",
    borderRadius: 12,
    overflow: "hidden",
  },
  title: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.textSecondary,
    textTransform: "uppercase",
  },
  body: {
    padding: 12,
  },
  bodyDetailed: {
    flexDirection: "row",
    gap: 12,
    alignItems: "stretch",
  },
  bodyDetailedStacked: {
    flexDirection: "column",
  },
}));
