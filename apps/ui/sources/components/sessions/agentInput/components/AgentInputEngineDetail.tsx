import * as React from "react";
import { ScrollView, View } from 'react-native';
import { StyleSheet } from "react-native-unistyles";

import {
  OptionPickerOverlay,
  type OptionPickerFavoriteOptions,
  type OptionPickerOption,
  type OptionPickerProbeState,
} from "@/components/sessions/pickers/OptionPickerOverlay";
import type {
  SessionConfigOption,
  SessionConfigOptionControl,
  SessionConfigOptionValueId,
} from "@/sync/domains/sessionControl/configOptionsControl";
import { OptionPickerPaneSlotsContext } from "@/components/sessions/pickers/optionPickerPaneSlots";
import { SessionModelApplyTimingContext } from "@/components/sessions/modelPicker/SessionModelSourceBrowseHandoff";
import { SELECTION_LIST_CARD_CONTENT_INSET_PX } from "@/components/ui/selectionList/_constants";
import { Text } from "@/components/ui/text/Text";
import { Typography } from "@/constants/Typography";
import { t } from "@/text";

import { AgentInputSessionConfigOptionsSection } from "./AgentInputSessionConfigOptionsSection";

type AgentInputEngineModelOption = Readonly<{
  value: string;
  label: string;
  icon?: React.ReactNode;
  trailingStatusIcon?: React.ReactNode;
  description: string;
  accessibilityLabel?: string;
  modelOptions?: ReadonlyArray<SessionConfigOption>;
}>;

type AgentInputEngineDetailProps = Readonly<{
  modelOptions?: ReadonlyArray<AgentInputEngineModelOption>;
  selectedModelId?: string;
  modelSummary?: React.ReactNode;
  modelNotes?: ReadonlyArray<string>;
  /** When a model change takes effect; the default surface carries it inside `modelSummary`. */
  modelApplyTiming?: string;
  modelEmptyText?: string;
  canEnterCustomModel?: boolean;
  modelProbe?: OptionPickerProbeState;
  modelHeaderAccessory?: React.ReactNode;
  /** Optional canonical model surface used when the caller carries typed model identities. */
  modelContentOverride?: React.ReactNode;
  /** The disableable routing hint for the selected Agent's pools; it owns its own setting gate. */
  modelRoutingHint?: React.ReactNode;
  favoriteModelValues?: ReadonlySet<string>;
  isModelFavoritable?: (option: AgentInputEngineModelOption) => boolean;
  onToggleFavoriteModel?: (option: AgentInputEngineModelOption) => void;
  onSelectModel?: (value: string) => void;
  onSubmitCustomValue?: (value: string) => void | Promise<void>;
  selectedModelOptionControls?: ReadonlyArray<SessionConfigOptionControl> | null;
  onSelectModelOptionValue?: (
    configId: string,
    valueId: SessionConfigOptionValueId,
  ) => void;

  configControls?: ReadonlyArray<SessionConfigOptionControl> | null;
  configNotes?: ReadonlyArray<string>;
  configProbe?: OptionPickerProbeState;
  onSelectConfigValue?: (
    configId: string,
    valueId: SessionConfigOptionValueId,
  ) => void;

  surfaceVariant?: "carded" | "plain";
  fillAvailableSpace?: boolean;
}>;

function wrapSection(
  variant: AgentInputEngineDetailProps["surfaceVariant"],
  key: string,
  content: React.ReactNode,
  fillAvailableSpace = false,
) {
  if (!content) return null;
  if (variant === "plain") {
    return <React.Fragment key={key}>{content}</React.Fragment>;
  }
  return (
    <View
      key={key}
      style={[
        styles.sectionCard,
        fillAvailableSpace ? styles.sectionCardFill : null,
      ]}
    >
      {content}
    </View>
  );
}

function orderFavoriteModelOptionsFirst(
  options: ReadonlyArray<AgentInputEngineModelOption>,
  favoriteValues: ReadonlySet<string> | null | undefined,
): ReadonlyArray<AgentInputEngineModelOption> {
  if (!favoriteValues || favoriteValues.size === 0) return options;

  const favoriteOptions: AgentInputEngineModelOption[] = [];
  const otherOptions: AgentInputEngineModelOption[] = [];
  for (const option of options) {
    if (favoriteValues.has(option.value)) {
      favoriteOptions.push(option);
    } else {
      otherOptions.push(option);
    }
  }

  if (favoriteOptions.length === 0) return options;
  return [...favoriteOptions, ...otherOptions];
}

export function AgentInputEngineDetail(props: AgentInputEngineDetailProps) {
  const surfaceVariant = props.surfaceVariant ?? "carded";
  const hasModelSection =
    props.modelContentOverride !== undefined
    || (props.modelOptions?.length ?? 0) > 0
    || props.modelSummary !== undefined
    || props.canEnterCustomModel === true
    || (props.modelNotes?.length ?? 0) > 0
    || (props.modelProbe !== undefined && props.modelProbe.phase !== "idle");
  const hasConfigSection =
    (props.configControls?.length ?? 0) > 0
    || (props.configNotes?.length ?? 0) > 0;
  // The producer's array order is the priority: a model-category control it lists before its model
  // selector sits above the model, one it lists after sits directly beneath it, the rest follow.
  const configBlocks = React.useMemo(() => {
    const controls = props.configControls ?? [];
    const blocks = [
      { key: "before", controls: controls.filter((control) => control.modelPlacement === "before") },
      { key: "after", controls: controls.filter((control) => control.modelPlacement === "after") },
      { key: "rest", controls: controls.filter((control) => control.modelPlacement === undefined) },
    ];
    return blocks.map((block) => ({ ...block, hasControls: block.controls.length > 0 }));
  }, [props.configControls]);

  const resolvedModelOptions = React.useMemo(() => {
    const options = props.modelOptions ?? [];
    const shouldShowDescriptions = options.some(
      (option) =>
        option.value !== "default" &&
        typeof option.description === "string" &&
        option.description.trim().length > 0,
    );

    const describedOptions = shouldShowDescriptions ? options.map((option) => {
      if (option.value !== "default") return option;
      if (typeof option.description === "string" && option.description.trim().length > 0) {
        return option;
      }
      return { ...option, description: t("agentInput.model.configureInCli") };
    }) : options;

    return orderFavoriteModelOptionsFirst(describedOptions, props.favoriteModelValues);
  }, [props.favoriteModelValues, props.modelOptions]);

  const favoriteOptions = React.useMemo<OptionPickerFavoriteOptions | undefined>(() => {
    if (!props.onToggleFavoriteModel || !props.favoriteModelValues) {
      return undefined;
    }

    return {
      values: props.favoriteModelValues,
      isFavoritable: props.isModelFavoritable
        ? (option: OptionPickerOption) => props.isModelFavoritable?.(option as AgentInputEngineModelOption) === true
        : undefined,
      onToggle: (option: OptionPickerOption) => {
        props.onToggleFavoriteModel?.(option as AgentInputEngineModelOption);
      },
    };
  }, [
    props.favoriteModelValues,
    props.isModelFavoritable,
    props.onToggleFavoriteModel,
  ]);

  // A replacing model surface draws its own running line; it gets the same timing and notes the
  // default surface would have shown, so a running session says when a change applies either way.
  const modelNotes = props.modelNotes;
  const applyTiming = React.useMemo(() => (
    props.modelApplyTiming ? { timing: props.modelApplyTiming, notes: modelNotes ?? [] } : null
  ), [modelNotes, props.modelApplyTiming]);
  const modelContentOverride = props.modelContentOverride !== undefined && applyTiming ? (
    <SessionModelApplyTimingContext.Provider value={applyTiming}>
      {props.modelContentOverride}
    </SessionModelApplyTimingContext.Provider>
  ) : props.modelContentOverride;

  if (!hasModelSection && !hasConfigSection) {
    return null;
  }

  const modelSection = hasModelSection
    ? wrapSection(
        surfaceVariant,
        "model",
        modelContentOverride ?? <OptionPickerOverlay
          title={t("agentInput.model.title")}
          summary={props.modelSummary}
          notes={props.modelNotes ?? []}
          options={resolvedModelOptions}
          selectedValue={props.selectedModelId ?? "default"}
          emptyText={
            props.modelEmptyText ?? t("agentInput.model.configureInCli")
          }
          canEnterCustomValue={props.canEnterCustomModel === true}
          customLabel={`${t("profiles.custom")}...`}
          customDescription={t("agentInput.model.customDescription")}
          favoriteOptions={favoriteOptions}
          headerAccessory={props.modelHeaderAccessory}
          probe={props.modelProbe}
          selectedOptionControls={props.selectedModelOptionControls ?? undefined}
          onSelectOptionControlValue={props.onSelectModelOptionValue}
          onSelect={props.onSelectModel ?? (() => {})}
          onSubmitCustomValue={props.onSubmitCustomValue}
          fillAvailableSpace={props.fillAvailableSpace}
        />,
        props.fillAvailableSpace,
      )
    : null;

  // Native guidance (a rejected provider, unavailable options) leads the first block that is shown,
  // or stands alone when the producer reported no control at all.
  const notes = props.configNotes ?? [];
  const notesBlockKey = configBlocks.find((block) => block.hasControls)?.key ?? "rest";
  const configBlockNodes = configBlocks.map((block) => {
    const blockNotes = block.key === notesBlockKey ? notes : [];
    if (!block.hasControls && blockNotes.length === 0) return null;
    return wrapSection(
      surfaceVariant,
      `config:${block.key}`,
      <View style={styles.configSection}>
        {blockNotes.map((note, index) => (
          <Text
            key={`${index}:${note}`}
            testID={index === 0 ? "agent-input-config-options-unavailable" : undefined}
            style={styles.configNote}
          >
            {note}
          </Text>
        ))}
        <AgentInputSessionConfigOptionsSection
          controls={block.controls}
          onSelectValue={props.onSelectConfigValue}
        />
      </View>,
    );
  });

  const routingHint = hasModelSection ? props.modelRoutingHint ?? null : null;
  if (props.fillAvailableSpace !== true) {
    return (
      <View style={styles.container}>
        {routingHint}
        {configBlockNodes[0]}
        {modelSection}
        {configBlockNodes[1]}
        {configBlockNodes[2]}
      </View>
    );
  }
  // The model surface's one scroll owner carries everything around it, so the whole pane scrolls as one.
  const paneSlots = {
    leading: routingHint || configBlockNodes[0] ? <View style={styles.container}>{routingHint}{configBlockNodes[0]}</View> : null,
    trailing: configBlockNodes[1] || configBlockNodes[2] ? <View style={styles.container}>{configBlockNodes[1]}{configBlockNodes[2]}</View> : null,
  };
  // One container for the whole life of a filling pane: the producer's catalog arriving or being
  // withdrawn only changes whether this scrolls, so the model surface keeps its search, scroll and focus.
  return (
    <OptionPickerPaneSlotsContext.Provider value={paneSlots}>
      <ScrollView
        style={styles.containerFill}
        contentContainerStyle={hasModelSection ? styles.containerFill : [styles.container, styles.controlsOnlyInset]}
        scrollEnabled={!hasModelSection}
      >
        {hasModelSection ? modelSection : (
          <>
            {configBlockNodes[0]}
            {configBlockNodes[1]}
            {configBlockNodes[2]}
          </>
        )}
      </ScrollView>
    </OptionPickerPaneSlotsContext.Provider>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.space.s10,
  },
  // No model surface to carry the pane's top and bottom inset.
  controlsOnlyInset: {
    paddingVertical: theme.space.s16,
  },
  containerFill: {
    flex: 1,
    minHeight: 0,
  },
  sectionCard: {
    overflow: "hidden",
  },
  sectionCardFill: {
    flex: 1,
    minHeight: 0,
  },
  configSection: {
    gap: theme.space.s8,
  },
  configNote: {
    ...Typography.variant("meta"),
    color: theme.colors.text.tertiary,
    paddingHorizontal: SELECTION_LIST_CARD_CONTENT_INSET_PX,
  },
}));
