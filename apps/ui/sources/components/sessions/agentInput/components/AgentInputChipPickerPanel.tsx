import React from "react";
import { Platform, ScrollView, useWindowDimensions, View } from 'react-native';
import { StyleSheet } from "react-native-unistyles";

import { Item } from "@/components/ui/lists/Item";
import { ItemGroup } from "@/components/ui/lists/ItemGroup";
import { ItemListStatic } from "@/components/ui/lists/ItemList";
import { Text } from "@/components/ui/text/Text";
import { t } from "@/text";
import { ModalCloseButton } from '@/modal/components/card';

import { AgentInputChipPickerDetailPane } from "./AgentInputChipPickerDetailPane";
import { shouldShowAgentInputChipPickerRail } from "./AgentInputChipPickerLayout";
import { AgentInputChipPickerOptionSelector } from "./AgentInputChipPickerOptionSelector";
import {
  AGENT_INPUT_CHIP_PICKER_DETAIL_MIN_HEIGHT,
  agentInputChipPickerHasDetailPane,
  buildAgentInputChipPickerSections,
  type AgentInputChipPickerPanelProps,
} from "./AgentInputChipPickerTypes";
import { deferAgentInputPopoverClose } from "@/components/sessions/agentInput/selection/deferAgentInputPopoverClose";

export {
  type AgentInputChipPickerOption,
  type AgentInputChipPickerPanelProps,
} from "./AgentInputChipPickerTypes";

export function AgentInputChipPickerPanel(
  props: AgentInputChipPickerPanelProps,
) {
  const { width: windowWidth } = useWindowDimensions();
  const styles = stylesheet;
  const sections = React.useMemo(
    () => buildAgentInputChipPickerSections(props.options),
    [props.options],
  );
  const detailed = React.useMemo(
    () => agentInputChipPickerHasDetailPane(props.options),
    [props.options],
  );
  const showDetailedSelector = detailed;
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
        const currentOption = current
          ? props.options.find((option) => option.id === current) ?? null
          : null;
        if (
          currentOption?.preserveFocusOnExternalSelectionChange === true
          && props.options.some((option) => option.id === current)
        ) {
          return current;
        }
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

  const handleDetailedOptionFocus = React.useCallback((optionId: string) => {
    setFocusedOptionId(optionId);
    const option = props.options.find((candidate) => candidate.id === optionId) ?? null;
    if (!option || option.disabled) {
      return;
    }
    if (option.onApply) {
      return;
    }
    if (option.onSelectImmediate) {
      option.onSelectImmediate();
      // For selectors with a detail pane (e.g. engine + model), keep the popover
      // open so users can continue configuring the newly focused option.
      const canFocusOptionInPlace = typeof option.renderDetailContent === "function";
      if (!canFocusOptionInPlace && option.closeOnSelectImmediate !== false) {
        deferAgentInputPopoverClose(props.onRequestClose);
      }
      return;
    }
  }, [props.onRequestClose, props.options]);

  const detailedLayout =
    shouldShowAgentInputChipPickerRail(props.options, windowWidth)
      ? "split"
      : "stacked";
  const detailPaneStyle =
    detailedLayout === "split" ? styles.detailPaneSplit : null;
  const detailContainerStyle =
    detailedLayout === "split"
      ? styles.detailScroll
      : styles.detailStackedWithSelector;
  const railWidth = props.railWidth ?? styles.railScroll.width;
  const railMaxWidth = props.railMaxWidth ?? styles.railScroll.maxWidth;
  const railMaxHeight =
    typeof props.maxHeight === "number"
      ? props.maxHeight
      : AGENT_INPUT_CHIP_PICKER_DETAIL_MIN_HEIGHT;
  const boundedDetailStyle = props.detailContentOwnsScroll === true
    && typeof props.maxHeight === "number"
    ? { height: props.maxHeight, maxHeight: props.maxHeight }
    : null;

  const showCloseButton = props.showCloseButton !== false;
  const shouldRenderTitle = typeof props.title === "string" && props.title.trim().length > 0;
  const headerRow = shouldRenderTitle || showCloseButton ? (
    <View style={styles.headerRow}>
      <View style={styles.headerTitleWrap}>
        {shouldRenderTitle ? (
          <Text testID="agent-input-chip-picker.title" style={styles.title}>
            {props.title}
          </Text>
        ) : null}
      </View>
      {showCloseButton ? (
        <ModalCloseButton testID="agent-input-chip-picker.close" onPress={props.onRequestClose} />
      ) : null}
    </View>
  ) : null;

  return (
    <View
      testID="agent-input-chip-picker"
      style={[styles.container, boundedDetailStyle]}
    >
      {!detailed ? (
        <View style={styles.body}>
          {headerRow}
          <ItemListStatic style={{ backgroundColor: "transparent" }}>
            {sections.map((section) => (
              <ItemGroup key={section.id} title={section.label ?? ""}>
                {section.options.map((option, index) => (
                  <Item
                    key={option.id}
                    testID={`agent-input-chip-picker.option:${option.id}`}
                    title={option.label}
                    subtitle={option.subtitle}
                    icon={option.icon}
                    selected={props.selectedOptionId === option.id}
                    disabled={option.disabled}
                    showChevron={false}
                    showDivider={index < section.options.length - 1}
                    onPress={() => {
                      if (option.disabled) return;
                      props.onSelect(option.id);
                      deferAgentInputPopoverClose(props.onRequestClose);
                    }}
                  />
                ))}
              </ItemGroup>
            ))}
          </ItemListStatic>
        </View>
      ) : (
        <View style={styles.bodyDetailedShell}>
          {headerRow ? <View style={styles.headerDetailed}>{headerRow}</View> : null}
          <View
            style={[
              styles.bodyDetailed,
              showDetailedSelector && detailedLayout === "stacked"
                ? styles.bodyDetailedStacked
                : null,
            ]}
          >
            {showDetailedSelector ? (
              detailedLayout === "split" ? (
                <ScrollView
                  testID="agent-input-chip-picker.option-rail-scroll"
                  style={[
                    styles.railScroll,
                    { width: railWidth, maxWidth: railMaxWidth, maxHeight: railMaxHeight },
                  ]}
                  contentContainerStyle={styles.railScrollContent}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                >
                  <AgentInputChipPickerOptionSelector
                    sections={sections}
                    focusedOptionId={focusedOption?.id ?? null}
                    selectedOptionId={props.selectedOptionId}
                    onFocusOption={handleDetailedOptionFocus}
                    variant="rail"
                  />
                </ScrollView>
              ) : (
                <View>
                  <AgentInputChipPickerOptionSelector
                    sections={sections}
                    focusedOptionId={focusedOption?.id ?? null}
                    selectedOptionId={props.selectedOptionId}
                    onFocusOption={handleDetailedOptionFocus}
                    variant="stacked"
                  />
                </View>
              )
            ) : null}
            {focusedOption ? (
              <View style={detailContainerStyle}>
                <View
                  style={[
                    styles.detailPane,
                    detailedLayout === "split" ? styles.detailScrollContent : null,
                    Platform.OS === "web"
                      && detailedLayout === "stacked"
                      && props.detailContentOwnsScroll === true
                      ? styles.detailPaneOwnScroll
                      : null,
                  ]}
                >
                  {props.detailPaneHeaderAccessory ? (
                    <View style={styles.detailPaneHeaderAccessoryRow}>
                      {props.detailPaneHeaderAccessory}
                    </View>
                  ) : null}
                  <AgentInputChipPickerDetailPane
                    style={detailPaneStyle}
                    option={focusedOption}
                    onApply={() => {
                      if (focusedOption.disabled) return;
                    if (focusedOption.onApply) {
                      focusedOption.onApply();
                    } else {
                      props.onSelect(focusedOption.id);
                    }
                    deferAgentInputPopoverClose(props.onRequestClose);
                  }}
                  applyLabel={props.applyLabel ?? t("common.use")}
                  onSelectDetailOption={(id) => {
                    props.onSelect(id);
                  }}
                    onRequestClose={props.onRequestClose}
                  />
                </View>
              </View>
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    width: "100%",
    overflow: "hidden",
    backgroundColor: theme.colors.surface.base,
  },
  title: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.text.secondary,
    textTransform: "uppercase",
  },
  body: {
    padding: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  headerDetailed: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.default,
  },
  bodyDetailedShell: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface.base,
  },
  bodyDetailed: {
    flex: 1,
    flexDirection: "row",
    alignItems: "stretch",
    minHeight: AGENT_INPUT_CHIP_PICKER_DETAIL_MIN_HEIGHT,
    backgroundColor: theme.colors.surface.base,
  },
  bodyDetailedStacked: {
    flexDirection: "column",
    padding: 0,
    gap: 0,
    minHeight: 0,
  },
  railScroll: {
    width: 190,
    maxWidth: "30%",
    backgroundColor: theme.colors.background.canvas,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border.default,
  },
  railScrollContent: {
    paddingBottom: 10,
  },
  detailScroll: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface.base,
  },
  detailStackedWithSelector: {
    width: "100%",
    flexShrink: 1,
    padding: 10,
  },
  detailScrollContent: {
    paddingHorizontal: 12,
    paddingVertical: 15,
    flex: 1,
    minHeight: 0,
  },
  detailPaneHeaderAccessoryRow: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 1,
  },
  detailPaneSplit: {
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  detailPane: {
    position: 'relative',
  },
  detailPaneOwnScroll: {
    flex: 1,
    minHeight: 0,
  },
}));
