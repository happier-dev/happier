import React from "react";
import { ScrollView, useWindowDimensions, View } from 'react-native';
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
  // Deliberately NOT gated on `props.options.length > 1`. In-session there is exactly
  // one agent option, but this same detail pane is where the MODEL is chosen, so
  // collapsing it at a single option would make in-session model selection unreachable.
  const showDetailedSelector = detailed;
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
                    // `detailContentOwnsScroll` also switches the surrounding
                    // popover's own scroll OFF, on every platform. The split
                    // column bounds the pane through `detailScrollContent`;
                    // stacked has to bound it here or the pane grows past a
                    // container that is `overflow: hidden` and no longer
                    // scrolls — clipping whatever the detail renders last,
                    // which is its primary action. Measured before this line
                    // was unguarded: the apply button sat 162 px below the
                    // container's bottom edge with no way to reach it.
                    detailedLayout === "stacked" && props.detailContentOwnsScroll === true
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
                  applyLabel={focusedOption.applyLabel ?? props.applyLabel ?? t("common.use")}
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
