import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { t } from '@/text';

const VISUAL_SIZE = 24;
const FIELD_EDGE_INSET = 6;

/** One reservation for the shared field corner, independent of voice availability. */
export function resolveAgentInputFieldAccessoryGeometry(input: Readonly<{
    library: boolean;
    accessory: boolean;
    belowToggle: boolean;
    platform?: string;
}>) {
    const targetSize = resolveMinimumInteractiveTargetSize(input.platform ?? Platform.OS);
    const width = (Number(input.library) + Number(input.accessory)) * targetSize;
    return {
        targetSize,
        width,
        top: input.belowToggle ? 30 : 2,
        right: FIELD_EDGE_INSET - (targetSize - VISUAL_SIZE) / 2,
        paddingRight: width ? width + FIELD_EDGE_INSET : undefined,
    };
}

export function AgentInputFieldAccessories(props: Readonly<{
    showLibrary: boolean;
    onOpenLibrary: () => void;
    accessory?: React.ReactNode;
    belowToggle: boolean;
    /**
     * `field` (default): the field's top-right corner. `actionRow`: inline at the end of the composer's
     * chip row, after its own chips (lab `editor-E1`: … Step options · attach · mic), for a composer
     * that authors a document (`voiceAffordance="dictation"`).
     */
    placement?: 'field' | 'actionRow';
}>) {
    const geometry = resolveAgentInputFieldAccessoryGeometry({
        library: props.showLibrary,
        accessory: props.accessory != null,
        belowToggle: props.belowToggle,
    });
    if (!geometry.width) return null;
    const inRow = props.placement === 'actionRow';
    return (
        <View testID="agent-input-field-accessories" style={inRow ? [styles.row, { height: geometry.targetSize }] : [styles.cluster, {
            width: geometry.width, height: geometry.targetSize, top: geometry.top, right: geometry.right,
        }]}>
            {props.showLibrary ? (
                <View style={[styles.target, inRow ? styles.inRow : null, { width: geometry.targetSize, height: geometry.targetSize }]}>
                    <IconButton
                        testID="agent-input-prompt-library"
                        iconName="book-open"
                        accessibilityLabel={t('agentInput.promptPicker.open')}
                        tooltip={t('agentInput.promptPicker.open')}
                        variant="plain"
                        size={VISUAL_SIZE}
                        iconSize={16}
                        minimumInteractiveTargetSize={geometry.targetSize}
                        interactiveTargetGapPx={geometry.targetSize}
                        onPress={props.onOpenLibrary}
                    />
                </View>
            ) : null}
            {props.accessory != null ? (
                <View style={[styles.accessory, inRow ? styles.inRow : null, { width: geometry.targetSize, height: geometry.targetSize }]}>
                    {props.accessory}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    cluster: { position: 'absolute', zIndex: 2, flexDirection: 'row', alignItems: 'flex-start' },
    row: { flexDirection: 'row', alignItems: 'center' },
    target: { alignItems: 'center', justifyContent: 'flex-start', paddingTop: 4 },
    accessory: { position: 'relative', alignItems: 'center', justifyContent: 'flex-start', paddingTop: 4 },
    // In the chip row the icons sit on the chips' line (lab editor-E1), centred in their targets
    // rather than hung from the field's top corner (DESIGN-7 P1).
    inRow: { justifyContent: 'center', paddingTop: 0 },
});
