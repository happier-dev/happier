import * as React from "react";
import { View } from 'react-native';
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
import { Text } from "@/components/ui/text/Text";
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
  modelEmptyText?: string;
  canEnterCustomModel?: boolean;
  modelProbe?: OptionPickerProbeState;
  modelHeaderAccessory?: React.ReactNode;
  /** Optional canonical model surface used when the caller carries typed model identities. */
  modelContentOverride?: React.ReactNode;
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

  sectionOrder?: ReadonlyArray<"model" | "config">;
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
      style={[styles.sectionCard, fillAvailableSpace ? styles.sectionCardFill : null]}
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
  const sectionOrder = props.sectionOrder ?? ["model", "config"];
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

  if (!hasModelSection && !hasConfigSection) {
    return null;
  }

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

  const sections: Record<"model" | "config", React.ReactNode | null> =
    {
      model: hasModelSection
        ? wrapSection(
            surfaceVariant,
            "model",
            props.modelContentOverride ?? <OptionPickerOverlay
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
        : null,
      config: hasConfigSection
        ? wrapSection(
            surfaceVariant,
            "config",
            <View style={styles.configSection}>
              {(props.configNotes ?? []).map((note, index) => (
                <Text
                  key={`${index}:${note}`}
                  testID={index === 0 ? "agent-input-config-options-unavailable" : undefined}
                  style={styles.configNote}
                >
                  {note}
                </Text>
              ))}
              <AgentInputSessionConfigOptionsSection
                controls={props.configControls ?? []}
                onSelectValue={props.onSelectConfigValue}
              />
            </View>,
          )
        : null,
    };

  return (
    <View style={[styles.container, props.fillAvailableSpace ? styles.containerFill : null]}>
      {sectionOrder.map((sectionId) => sections[sectionId])}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: 10,
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
    gap: 8,
  },
  configNote: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.text.secondary,
  },
}));
