import React from "react";
import { ScrollView, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { Item } from "@/components/ui/lists/Item";
import { ItemGroup } from "@/components/ui/lists/ItemGroup";
import { ItemListStatic } from "@/components/ui/lists/ItemList";
import { Text } from "@/components/ui/text/Text";
import { Typography } from "@/constants/Typography";
import { t } from "@/text";
import { ModalCloseButton } from '@/modal/components/card';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';

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
  const { theme } = useUnistyles();
  // The rail is part of the panel's material: solid it is the canvas step, over glass only a faint secondary tint
  // (owner 2026-11-11 desktop #23: an opaque near-black rail beside the glass model column).
  const paintColor = useHappierMaterialColorResolver();
  const railFill = paintColor(theme.colors.background.canvas, theme.colors.surface.sectionTint);
  const railFades = useScrollEdgeFades({ enabledEdges: { top: true, bottom: true } });
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

  // A narrow window (a phone) stacks the Agent strip above the same detail as the wide rail layout:
  // switching Agents happens in place, with no drill-in (owner R5, 2026-11-09).
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
  const railWidth = props.railWidth ?? styles.railFrame.width;
  const railMaxWidth = props.railMaxWidth ?? styles.railFrame.maxWidth;
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
              boundedDetailStyle ? { minHeight: 0 } : null,
              showDetailedSelector && detailedLayout === "stacked"
                ? styles.bodyDetailedStacked
                : null,
            ]}
          >
            {showDetailedSelector ? (
              detailedLayout === "split" ? (
                <View style={[styles.railFrame, { width: railWidth, maxWidth: railMaxWidth, maxHeight: railMaxHeight, backgroundColor: railFill }]}>
                  <ScrollView
                    testID="agent-input-chip-picker.option-rail-scroll"
                    style={styles.railScroll}
                    contentContainerStyle={styles.railScrollContent}
                    keyboardShouldPersistTaps="handled"
                    nestedScrollEnabled
                    showsVerticalScrollIndicator
                    onLayout={railFades.onViewportLayout}
                    onContentSizeChange={railFades.onContentSizeChange}
                    onScroll={railFades.onScroll}
                    onMomentumScrollEnd={railFades.onMomentumScrollEnd}
                    scrollEventThrottle={32}
                  >
                    <AgentInputChipPickerOptionSelector
                      sections={sections}
                      focusedOptionId={focusedOption?.id ?? null}
                      selectedOptionId={props.selectedOptionId}
                      onFocusOption={handleDetailedOptionFocus}
                      variant="rail"
                    />
                  </ScrollView>
                  <ScrollEdgeFades color={theme.colors.background.canvas} size={theme.space.s16} edges={railFades.visibility} />
                </View>
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
              <View style={[
                detailContainerStyle,
                // A detail that owns its scroll (the model list) takes the room under the Agent strip: on native a
                // flexing list under an auto-height parent collapses to nothing (iOS QA: an empty model area).
                detailedLayout === "stacked" && props.detailContentOwnsScroll === true ? styles.detailStackedFill : null,
                detailedLayout === "stacked" && props.detailContentOwnsScroll === true ? styles.detailScrollContentFlush : null,
              ]}>
                <View
                  style={[
                    styles.detailPane,
                    detailedLayout === "split" ? styles.detailScrollContent : null,
                    // A detail that owns its scroll carries its own top and bottom inset,
                    // so its content reaches both edges of the pane as it scrolls.
                    props.detailContentOwnsScroll === true
                      ? styles.detailScrollContentFlush
                      : null,
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
  // The picker's panes sit on the popover's material; only the wide rail is tinted as its own column.
  container: {
    width: "100%",
    overflow: "hidden",
  },
  title: {
    ...Typography.variant('body', 'semiBold'),
    color: theme.colors.text.primary,
  },
  body: {
    padding: theme.space.s12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.s10,
  },
  headerTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  headerDetailed: {
    paddingHorizontal: theme.space.s12,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.default,
  },
  bodyDetailedShell: {
    flex: 1,
    minHeight: 0,
  },
  bodyDetailed: {
    flex: 1,
    flexDirection: "row",
    alignItems: "stretch",
    minHeight: AGENT_INPUT_CHIP_PICKER_DETAIL_MIN_HEIGHT,
  },
  bodyDetailedStacked: {
    flexDirection: "column",
    padding: 0,
    gap: 0,
    minHeight: 0,
  },
  railFrame: {
    position: 'relative',
    flexShrink: 1,
    minHeight: 0,
    // Wide enough for an engine name beside the row's reserved favorite and check slots.
    width: 232,
    maxWidth: "34%",
    borderRightWidth: 1,
    borderRightColor: theme.colors.border.default,
  },
  railScroll: {
    flex: 1,
    minHeight: 0,
  },
  railScrollContent: {
    paddingBottom: theme.space.s10,
  },
  detailScroll: {
    flex: 1,
    minHeight: 0,
  },
  detailStackedFill: {
    flex: 1,
    minHeight: 0,
  },
  detailStackedWithSelector: {
    width: "100%",
    flexShrink: 1,
    padding: theme.space.s10,
  },
  detailScrollContent: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: 15,
    flex: 1,
    minHeight: 0,
  },
  detailScrollContentFlush: {
    paddingVertical: 0,
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
