import React from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { normalizeNodeForView } from "@/components/ui/rendering/normalizeNodeForView";

import { AGENT_INPUT_CHIP_PICKER_OPTION_ICON_SIZE } from "./agentInputChipPickerOptionStyles";

export function normalizeAgentInputChipPickerOptionIcon(icon: React.ReactNode): React.ReactNode {
    if (!icon) return undefined;

    const resizedIcon = React.isValidElement(icon) && icon.type !== React.Fragment
        ? React.cloneElement(icon as React.ReactElement<Record<string, unknown>>, {
            size: AGENT_INPUT_CHIP_PICKER_OPTION_ICON_SIZE,
        })
        : icon;

    return (
        <View style={styles.iconWrapper}>
            {normalizeNodeForView(resizedIcon)}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    iconWrapper: {
        width: AGENT_INPUT_CHIP_PICKER_OPTION_ICON_SIZE,
        height: AGENT_INPUT_CHIP_PICKER_OPTION_ICON_SIZE,
        alignItems: "center",
        justifyContent: "center",
    },
}));
