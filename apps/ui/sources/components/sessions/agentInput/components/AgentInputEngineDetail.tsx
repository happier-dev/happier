import * as React from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import {
  ModelPickerOverlay,
  type ModelPickerProbeState,
} from "@/components/model/ModelPickerOverlay";
import type {
  AcpConfigOption,
  AcpConfigOptionControl,
  AcpConfigOptionValueId,
} from "@/sync/acp/configOptionsControl";
import { t } from "@/text";

import { AgentInputAcpConfigOptionsSection } from "./AgentInputAcpConfigOptionsSection";
import {
  AgentInputSessionModeSection,
  type AgentInputSessionModeOption,
} from "./AgentInputSessionModeSection";

type AgentInputEngineModelOption = Readonly<{
  value: string;
  label: string;
  description: string;
  modelOptions?: ReadonlyArray<AcpConfigOption>;
}>;

type AgentInputEngineDetailProps = Readonly<{
  modelOptions?: ReadonlyArray<AgentInputEngineModelOption>;
  selectedModelId?: string;
  effectiveModelLabel?: string;
  modelNotes?: ReadonlyArray<string>;
  modelEmptyText?: string;
  canEnterCustomModel?: boolean;
  modelProbe?: ModelPickerProbeState;
  onSelectModel?: (value: string) => void;
  onSubmitCustomModel?: (value: string) => void | Promise<void>;
  selectedModelOptionControls?: ReadonlyArray<AcpConfigOptionControl> | null;
  onSelectModelOptionValue?: (
    configId: string,
    valueId: AcpConfigOptionValueId,
  ) => void;

  sessionModeOptions?: ReadonlyArray<AgentInputSessionModeOption>;
  selectedSessionModeId?: string;
  sessionModeSummary?: React.ReactNode;
  sessionModeHeaderAccessory?: React.ReactNode;
  onSelectSessionMode?: (optionId: string) => void;

  configControls?: ReadonlyArray<AcpConfigOptionControl> | null;
  configHeaderAccessory?: React.ReactNode;
  onSelectConfigValue?: (
    configId: string,
    valueId: AcpConfigOptionValueId,
  ) => void;

  sectionOrder?: ReadonlyArray<"model" | "mode" | "config">;
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
  const sectionOrder = props.sectionOrder ?? ["model", "mode", "config"];
  const surfaceVariant = props.surfaceVariant ?? "carded";
  const hasModelSection =
    (props.modelOptions?.length ?? 0) > 0 || props.canEnterCustomModel === true;
  const hasModeSection = (props.sessionModeOptions?.length ?? 0) > 0;
  const hasConfigSection =
    (props.configControls?.length ?? 0) > 0 ||
    Boolean(props.configHeaderAccessory);

  if (!hasModelSection && !hasModeSection && !hasConfigSection) {
    return null;
  }

  const sections: Record<"model" | "mode" | "config", React.ReactNode | null> =
    {
      model: hasModelSection
        ? wrapSection(
            surfaceVariant,
            "model",
            <ModelPickerOverlay
              title={t("agentInput.model.title")}
              effectiveLabel={
                props.effectiveModelLabel ??
                props.selectedModelId ??
                t("agentInput.model.useCliSettings")
              }
              notes={props.modelNotes ?? []}
              options={props.modelOptions ?? []}
              selectedValue={props.selectedModelId ?? "default"}
              emptyText={
                props.modelEmptyText ?? t("agentInput.model.configureInCli")
              }
              canEnterCustomModel={props.canEnterCustomModel === true}
              customLabel={`${t("profiles.custom")}...`}
              customDescription={t("agentInput.model.customDescription")}
              probe={props.modelProbe}
              selectedOptionControls={props.selectedModelOptionControls ?? undefined}
              onSelectOptionControlValue={props.onSelectModelOptionValue}
              onSelect={props.onSelectModel ?? (() => {})}
              onSubmitCustomModel={props.onSubmitCustomModel}
            />,
          )
        : null,
      mode: hasModeSection
        ? wrapSection(
            surfaceVariant,
            "mode",
            <AgentInputSessionModeSection
              options={props.sessionModeOptions ?? []}
              selectedOptionId={props.selectedSessionModeId ?? "default"}
              summary={props.sessionModeSummary}
              headerAccessory={props.sessionModeHeaderAccessory}
              onSelectOption={props.onSelectSessionMode}
            />,
          )
        : null,
      config: hasConfigSection
        ? wrapSection(
            surfaceVariant,
            "config",
            <AgentInputAcpConfigOptionsSection
              controls={props.configControls ?? []}
              headerAccessory={props.configHeaderAccessory}
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
