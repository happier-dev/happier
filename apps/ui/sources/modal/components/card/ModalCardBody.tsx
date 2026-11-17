import { themeSurfaceDataSet } from '@happier-dev/plugin-ui';
import { useHappierThemeSurfaceOverridesEnabled } from '@happier-dev/plugin-ui/presentation';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
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
    const surfaceOverridesEnabled = useHappierThemeSurfaceOverridesEnabled();
    const surfaceBinding = { dataSet: themeSurfaceDataSet('dialog', 'body', 'default'), style: themeSurfaceStyles.surface(surfaceOverridesEnabled ? { surface: 'dialog', part: 'body' } : undefined) };
    const styles = stylesheet;
    const fill = props.fill ?? true;

    return (
        <View
            {...{ dataSet: surfaceBinding.dataSet }}
            testID={props.testID ?? 'modal-card-body'}
            style={[
                fill ? styles.fill : null,
                props.style,
                surfaceBinding.style,
            ]}
        >
            {props.children}
        </View>
    );
}
