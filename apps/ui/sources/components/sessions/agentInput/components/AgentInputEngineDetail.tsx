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
import { type AgentInputSessionModeOption } from "./AgentInputSessionModeSection";

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

  sessionModeOptions?: ReadonlyArray<AgentInputSessionModeOption>;
  selectedSessionModeId?: string;
  sessionModeSummary?: React.ReactNode;
  sessionModeHeaderAccessory?: React.ReactNode;
  onSelectSessionMode?: (optionId: string) => void;

  configControls?: ReadonlyArray<SessionConfigOptionControl> | null;
  configHeaderAccessory?: React.ReactNode;
  onSelectConfigValue?: (
    configId: string,
    valueId: SessionConfigOptionValueId,
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

  const selectedSessionModeName =
    props.sessionModeOptions?.find(
      (option) => option.id === props.selectedSessionModeId,
    )?.name ?? "";

  const sections: Record<"model" | "mode" | "config", React.ReactNode | null> =
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
              options={props.modelOptions ?? []}
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
      mode: hasModeSection
        ? wrapSection(
            surfaceVariant,
            "mode",
            <OptionPickerOverlay
              title={t("agentInput.mode.sectionTitle")}
              effectiveLabel={selectedSessionModeName}
              summary={props.sessionModeSummary}
              summaryTestID="agent-input-session-mode-summary"
              headerAccessory={props.sessionModeHeaderAccessory}
              options={(props.sessionModeOptions ?? []).map((option) => ({
                value: option.id,
                label: option.name,
                description: option.description,
              }))}
              optionTestIDPrefix="agent-input-session-mode-option"
              selectedValue={props.selectedSessionModeId ?? "default"}
              emptyText=""
              canEnterCustomValue={false}
              onSelect={props.onSelectSessionMode ?? (() => {})}
            />,
          )
        : null,
      config: hasConfigSection
        ? wrapSection(
            surfaceVariant,
            "config",
            <AgentInputSessionConfigOptionsSection
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
