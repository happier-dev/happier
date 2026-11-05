import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';
import { AGENT_INPUT_FIELD_ACCESSORY_EDGES_PX } from './agentInputChromeStyles';

const VISUAL_SIZE = 24;
const FIELD_EDGE_INSET = 6;

/** One reservation for the shared field corner, independent of voice availability. */
export function resolveAgentInputFieldAccessoryGeometry(input: Readonly<{
    library: boolean;
    accessory: boolean;
    belowToggle: boolean;
}>) {
    // The accessories are drawn at their design square under every pointer; a finger reaches them
    // through each button's hit area, never through a wider reservation in the field.
    const targetSize = VISUAL_SIZE;
    const width = (Number(input.library) + Number(input.accessory)) * targetSize;
    return {
        targetSize,
        width,
        // Below the toggle (bottom edge at 30) the drawn accessories sit 9 px under it, 4 of padding included.
        top: input.belowToggle ? 35 : 2,
        right: FIELD_EDGE_INSET,
        paddingRight: width ? width + FIELD_EDGE_INSET : undefined,
    };
}

export function AgentInputFieldAccessories(props: Readonly<{
    showLibrary: boolean;
    onOpenLibrary: () => void;
    /** The library picker is open: its trigger's tooltip steps aside, as every popover trigger's does. */
    libraryOpen?: boolean;
    accessory?: React.ReactNode;
    orderedIds?: readonly string[];
    belowToggle: boolean;
}>) {
    const geometry = resolveAgentInputFieldAccessoryGeometry({
        library: props.showLibrary,
        accessory: props.accessory != null,
        belowToggle: props.belowToggle,
    });
    if (!geometry.width) return null;
    const library = props.showLibrary ? (
        <View key="promptLibrary" style={[styles.target, { width: geometry.targetSize, height: geometry.targetSize }]}>
            <IconButton
                testID="agent-input-prompt-library"
                iconName="book-open"
                accessibilityLabel={t('agentInput.promptPicker.open')}
                tooltip={t('agentInput.promptPicker.open')}
                tooltipHidden={props.libraryOpen === true}
                variant="plain"
                size={VISUAL_SIZE}
                iconSize={16}
                interactiveTargetEdgesPx={AGENT_INPUT_FIELD_ACCESSORY_EDGES_PX}
                onPress={props.onOpenLibrary}
            />
        </View>
    ) : null;
    const accessory = props.accessory != null ? (
        <View key="accessory" style={[styles.accessory, { width: geometry.targetSize, height: geometry.targetSize }]}>
            {props.accessory}
        </View>
    ) : null;
    const dictateIndex = props.orderedIds?.indexOf('dictate') ?? -1;
    const libraryIndex = props.orderedIds?.indexOf('promptLibrary') ?? -1;
    const accessoryFirst = dictateIndex >= 0 && (libraryIndex < 0 || dictateIndex < libraryIndex);
    return (
        <View testID="agent-input-field-accessories" style={[styles.cluster, {
            width: geometry.width, height: geometry.targetSize, top: geometry.top, right: geometry.right,
        }]}>
            {accessoryFirst ? [accessory, library] : [library, accessory]}
        </View>
    );
}

const styles = StyleSheet.create({
    cluster: { position: 'absolute', zIndex: 2, flexDirection: 'row', alignItems: 'flex-start' },
    target: { alignItems: 'center', justifyContent: 'flex-start', paddingTop: 4 },
    accessory: { position: 'relative', alignItems: 'center', justifyContent: 'flex-start', paddingTop: 4 },
});
