import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

type ModalCardBodyProps = Readonly<{
    children: React.ReactNode;
    fill?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create(() => ({
    fill: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 'auto',
        minHeight: 0,
    },
}));

export function ModalCardBody(props: ModalCardBodyProps) {
    useUnistyles();
    const styles = stylesheet;
    const fill = props.fill ?? true;

    return (
        <View
            testID={props.testID ?? 'modal-card-body'}
            style={[
                fill ? styles.fill : null,
                props.style,
            ]}
        >
            {props.children}
        </View>
    );
}
