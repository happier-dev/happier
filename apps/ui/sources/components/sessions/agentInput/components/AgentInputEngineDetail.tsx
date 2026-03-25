import * as React from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import {
  OptionPickerOverlay,
  type OptionPickerProbeState,
} from "@/components/sessions/pickers/OptionPickerOverlay";
import type {
  SessionConfigOption,
  SessionConfigOptionControl,
  SessionConfigOptionValueId,
} from "@/sync/domains/sessionControl/configOptionsControl";
import { t } from "@/text";

import { AgentInputSessionConfigOptionsSection } from "./AgentInputSessionConfigOptionsSection";

type AgentInputEngineModelOption = Readonly<{
  value: string;
  label: string;
  description: string;
  modelOptions?: ReadonlyArray<SessionConfigOption>;
}>;

type AgentInputEngineDetailProps = Readonly<{
  modelOptions?: ReadonlyArray<AgentInputEngineModelOption>;
  selectedModelId?: string;
  effectiveModelLabel?: string;
  modelNotes?: ReadonlyArray<string>;
  modelEmptyText?: string;
  canEnterCustomModel?: boolean;
  modelProbe?: OptionPickerProbeState;
  onSelectModel?: (value: string) => void;
  onSubmitCustomValue?: (value: string) => void | Promise<void>;
  selectedModelOptionControls?: ReadonlyArray<SessionConfigOptionControl> | null;
  onSelectModelOptionValue?: (
    configId: string,
    valueId: SessionConfigOptionValueId,
  ) => void;

  configControls?: ReadonlyArray<SessionConfigOptionControl> | null;
  onSelectConfigValue?: (
    configId: string,
    valueId: SessionConfigOptionValueId,
  ) => void;

  sectionOrder?: ReadonlyArray<"model" | "config">;
  surfaceVariant?: "carded" | "plain";
}>;

function wrapSection(
  variant: AgentInputEngineDetailProps["surfaceVariant"],
  key: string,
  content: React.ReactNode,
) {
  if (!content) return null;
  if (variant === "plain") {
    return <React.Fragment key={key}>{content}</React.Fragment>;
  }
  return (
    <View key={key} style={styles.sectionCard}>
      {content}
    </View>
  );
}

export function AgentInputEngineDetail(props: AgentInputEngineDetailProps) {
  const sectionOrder = props.sectionOrder ?? ["model", "config"];
  const surfaceVariant = props.surfaceVariant ?? "carded";
  const hasModelSection =
    (props.modelOptions?.length ?? 0) > 0 || props.canEnterCustomModel === true;
  const hasConfigSection = (props.configControls?.length ?? 0) > 0;

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

    if (!shouldShowDescriptions) return options;

    return options.map((option) => {
      if (option.value !== "default") return option;
      if (typeof option.description === "string" && option.description.trim().length > 0) {
        return option;
      }
      return { ...option, description: t("agentInput.model.configureInCli") };
    });
  }, [props.modelOptions]);

  const sections: Record<"model" | "config", React.ReactNode | null> =
    {
      model: hasModelSection
        ? wrapSection(
            surfaceVariant,
            "model",
            <OptionPickerOverlay
              title={t("agentInput.model.title")}
              effectiveLabel={
                props.effectiveModelLabel ??
                props.selectedModelId ??
                t("agentInput.model.useCliSettings")
              }
              notes={props.modelNotes ?? []}
              options={resolvedModelOptions}
              selectedValue={props.selectedModelId ?? "default"}
              emptyText={
                props.modelEmptyText ?? t("agentInput.model.configureInCli")
              }
              canEnterCustomValue={props.canEnterCustomModel === true}
              customLabel={`${t("profiles.custom")}...`}
              customDescription={t("agentInput.model.customDescription")}
              probe={props.modelProbe}
              selectedOptionControls={props.selectedModelOptionControls ?? undefined}
              onSelectOptionControlValue={props.onSelectModelOptionValue}
              onSelect={props.onSelectModel ?? (() => {})}
              onSubmitCustomValue={props.onSubmitCustomValue}
            />,
          )
        : null,
      config: hasConfigSection
        ? wrapSection(
            surfaceVariant,
            "config",
            <AgentInputSessionConfigOptionsSection
              controls={props.configControls ?? []}
              onSelectValue={props.onSelectConfigValue}
            />,
          )
        : null,
    };

  return (
    <View style={styles.container}>
      {sectionOrder.map((sectionId) => sections[sectionId])}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: 10,
  },
  sectionCard: {
    overflow: "hidden",
  },
}));
