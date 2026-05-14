import * as React from 'react';
import { View } from 'react-native';

export const createReanimatedColorPickerMock = () => {
    const ColorPicker = (props: React.PropsWithChildren<{ testID?: string }>) => (
        <View testID={props.testID}>{props.children}</View>
    );

    return {
        default: ColorPicker,
        Panel1: () => <View />,
        HueSlider: () => <View />,
        OpacitySlider: () => <View />,
        Swatches: () => <View />,
    };
};
