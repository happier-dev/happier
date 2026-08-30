import React from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
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

type AgentInputChipPickerFocusState = Readonly<{
  selectedOptionId: string | null;
  focusedOptionId: string | null;
}>;

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
  const showDetailedSelector = detailed && props.options.length > 1;
  const selectedOptionId = props.selectedOptionId ?? null;
  const fallbackFocusedOptionId = selectedOptionId ?? props.options[0]?.id ?? null;
  const [focusState, setFocusState] = React.useState<AgentInputChipPickerFocusState>(() => ({
    selectedOptionId,
    focusedOptionId: fallbackFocusedOptionId,
  }));
  let focusedOptionId = focusState.focusedOptionId;

  if (focusState.selectedOptionId !== selectedOptionId) {
    const currentOption = focusedOptionId
      ? props.options.find((option) => option.id === focusedOptionId) ?? null
      : null;
    if (currentOption?.preserveFocusOnExternalSelectionChange !== true) {
      focusedOptionId = fallbackFocusedOptionId;
    }
    setFocusState({ selectedOptionId, focusedOptionId });
  } else if (
    focusedOptionId !== fallbackFocusedOptionId
    && !props.options.some((option) => option.id === focusedOptionId)
  ) {
    focusedOptionId = fallbackFocusedOptionId;
    setFocusState({ selectedOptionId, focusedOptionId });
  }

  const focusedOption = React.useMemo(
    () =>
      props.options.find((option) => option.id === focusedOptionId) ??
      props.options[0] ??
      null,
    [focusedOptionId, props.options],
  );

  const handleDetailedOptionFocus = React.useCallback((optionId: string) => {
    setFocusState((current) => current.focusedOptionId === optionId
      ? current
      : { ...current, focusedOptionId: optionId });
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
  const showSinglePaneDetailed = detailed && !showDetailedSelector && detailedLayout === "stacked";
  const detailPaneStyle =
    detailedLayout === "split"
      ? styles.detailPaneSplit
      : showSinglePaneDetailed
        ? styles.detailPaneSingle
        : null;
  // Split bounds its detail column on the scroller itself; this is the stacked container only.
  const detailContainerStyle = showSinglePaneDetailed
    ? styles.detailSinglePane
    : styles.detailStackedWithSelector;
  const railWidth = props.railWidth ?? styles.railScroll.width;
  const railMaxWidth = props.railMaxWidth ?? styles.railScroll.maxWidth;

  // The popover is a single scroll container for the whole panel, so reaching a lower model
  // scrolls the Agent rail out of view — measured at 824px of content in a 446px viewport, with
  // the rail travelling the full distance with it. Bounding both split columns to the popover's
  // own height gives each one its own scroller and leaves the outer one nothing to move.
  const splitColumnMaxHeight = typeof props.maxHeight === "number"
    ? props.maxHeight
    : AGENT_INPUT_CHIP_PICKER_DETAIL_MIN_HEIGHT;

  const optionSelector = (
    <AgentInputChipPickerOptionSelector
      sections={sections}
      focusedOptionId={focusedOption?.id ?? null}
      selectedOptionId={props.selectedOptionId}
      onFocusOption={handleDetailedOptionFocus}
      variant={detailedLayout === "stacked" ? "stacked" : "rail"}
    />
  );

  const detailPane = focusedOption ? (
    <View style={styles.detailPane}>
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
        applyLabel={focusedOption.applyLabel ?? props.applyLabel ?? t("common.use")}
        onSelectDetailOption={(id) => {
          props.onSelect(id);
        }}
        onRequestClose={props.onRequestClose}
      />
    </View>
  ) : null;

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
    <View testID="agent-input-chip-picker" style={styles.container}>
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
              detailedLayout === "stacked"
                ? showDetailedSelector
                  ? styles.bodyDetailedStacked
                  : styles.bodyDetailedSingle
                : null,
            ]}
          >
            {showDetailedSelector ? (
              detailedLayout === "split" ? (
                <ScrollView
                  testID="agent-input-chip-picker.option-rail-scroll"
                  style={[
                    styles.railScroll,
                    { width: railWidth, maxWidth: railMaxWidth, maxHeight: splitColumnMaxHeight },
                  ]}
                  contentContainerStyle={styles.railScrollContent}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                >
                  {optionSelector}
                </ScrollView>
              ) : (
                <View>{optionSelector}</View>
              )
            ) : null}
            {focusedOption ? (
              detailedLayout === "split" ? (
                <ScrollView
                  testID="agent-input-chip-picker.detail-scroll"
                  style={[styles.detailScroll, { maxHeight: splitColumnMaxHeight }]}
                  contentContainerStyle={styles.detailScrollContent}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                >
                  {detailPane}
                </ScrollView>
              ) : (
                <View style={detailContainerStyle}>{detailPane}</View>
              )
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
    backgroundColor: theme.colors.surface.base,
  },
  bodyDetailed: {
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
  bodyDetailedSingle: {
    flexDirection: "column",
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
    backgroundColor: theme.colors.surface.base,
  },
  detailSinglePane: {
    width: "100%",
    flexShrink: 1,
  },
  detailStackedWithSelector: {
    width: "100%",
    flexShrink: 1,
    padding: 10,
  },
  detailScrollContent: {
    paddingHorizontal: 12,
    paddingVertical: 15,
    flexGrow: 1,
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
  detailPaneSingle: {
    width: "100%",
    paddingHorizontal: 12,
    paddingTop: 19,
    paddingBottom: 12,
  },
  detailPane: {
    position: 'relative',
  }
}));
