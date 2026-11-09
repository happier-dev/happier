import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

export type PathAndResumeRowStyles = {
    pathRow: StyleProp<ViewStyle>;
    actionButtonsLeft: StyleProp<ViewStyle>;
};

export type PathAndResumeRowProps = {
    styles: PathAndResumeRowStyles;
    leadingControls?: ReadonlyArray<React.ReactNode>;
    trailingControls?: ReadonlyArray<React.ReactNode>;
    fillAvailableWidth?: boolean;
    /** Rides the rail's last line, after its controls (a phone composer's Voice and Send). */
    end?: React.ReactNode;
};

export function PathAndResumeRow(props: PathAndResumeRowProps) {
    const leadingControls = props.leadingControls?.filter(Boolean) ?? [];
    const trailingControls = props.trailingControls?.filter(Boolean) ?? [];
    if (leadingControls.length === 0 && trailingControls.length === 0 && props.end == null) return null;
    const widthFillStyle = props.fillAvailableWidth === false ? null : { flex: 1, minWidth: 0 };

    return (
        <View style={[props.styles.pathRow, widthFillStyle]} testID="agentInput-pathResumeRow">
            <View style={[props.styles.actionButtonsLeft, widthFillStyle]}>
                {leadingControls}
                {trailingControls}
                {props.end}
            </View>
        </View>
    );
}
