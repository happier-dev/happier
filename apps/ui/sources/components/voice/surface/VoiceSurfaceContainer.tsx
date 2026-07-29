import * as React from 'react';
import { View } from 'react-native';

export const VoiceSurfaceContainer = React.memo(function VoiceSurfaceContainer(props: Readonly<{ style: ReadonlyArray<unknown>; children: React.ReactNode; testID?: string }>) {
    return (
        <View testID={props.testID} collapsable={false} style={props.style as any}>
            {props.children}
        </View>
    );
});
