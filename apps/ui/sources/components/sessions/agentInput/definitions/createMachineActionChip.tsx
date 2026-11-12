import * as React from 'react';
import { StyleSheet, type View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from './agentInputChipIconMetrics';
import { AgentInputRailChip } from '@/components/sessions/agentInput/definitions/agentInputChipRowReach';

const styles = StyleSheet.create({
    chip: { maxWidth: '100%', flexShrink: 1 },
    label: { minWidth: 0, flexShrink: 1 },
});

export function createMachineActionChip(params: Readonly<{
    anchorRef: React.RefObject<View | null>;
    machineName?: string | null;
    tint: string;
    showLabel: boolean;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    onPress: () => void;
    /** A host whose Machine is fixed shows it without offering a choice. */
    disabled?: boolean;
}>): React.ReactNode {
    // `null`: no machine yet, so the chip asks where to run (58d AF1); its picker offers creating or adding one.
    const label = params.machineName === null
        ? t('agentInput.runOn')
        : (typeof params.machineName === 'string'
            ? params.machineName
            : t('newSession.selectMachineTitle'));
    return (
        <AgentInputRailChip
            ref={params.anchorRef}
            key="machine"
            testID="agent-input-machine-chip"
            onPress={params.disabled ? undefined : params.onPress}
            disabled={params.disabled === true}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: params.disabled === true }}
            style={(pressed) => [params.chipStyle(pressed), styles.chip]}
        >
            {normalizeNodeForView(<Icon name="desktop" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={params.tint} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
            {/* Optional origin/Home context precedes the exact Machine, so width pressure
                removes that context before truncating the execution destination. */}
            {params.showLabel ? (
                <Text numberOfLines={1} ellipsizeMode="head" style={[params.textStyle, styles.label]}>
                    {label}
                </Text>
            ) : null}
        </AgentInputRailChip>
    );
}
