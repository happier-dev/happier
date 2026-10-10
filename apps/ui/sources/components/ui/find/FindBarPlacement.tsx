import * as React from 'react';
import { View } from 'react-native';

import { ComposerKeyboardFloatingInset } from '@/components/sessions/keyboardAvoidance';
import { useDeviceType } from '@/utils/platform/responsive';

export function useFindBarPresentation(): 'inline' | 'keyboardSeated' {
    return useDeviceType() === 'phone' ? 'keyboardSeated' : 'inline';
}

/** One host placement for every Find bar; the terminal footer already follows the keyboard. */
export function FindBarPlacement(props: Readonly<{
    children(presentation: 'inline' | 'keyboardSeated'): React.ReactNode;
    seatedInFlow?: boolean;
    testID?: string;
}>) {
    const presentation = useFindBarPresentation();
    const seated = presentation === 'keyboardSeated';
    const bar = <View style={seated ? undefined : { maxWidth: 560, width: '100%' }}>
        {props.children(presentation)}
    </View>;
    if (seated && props.seatedInFlow) {
        return <View testID={props.testID} pointerEvents="box-none">{bar}</View>;
    }
    return seated
        ? <ComposerKeyboardFloatingInset testID={props.testID}
            style={{ position: 'absolute', left: 0, right: 0, zIndex: 20 }}>{bar}</ComposerKeyboardFloatingInset>
        : <View testID={props.testID} pointerEvents="box-none"
            style={{ position: 'absolute', top: 10, left: 14, right: 14, alignItems: 'flex-end', zIndex: 20 }}>{bar}</View>;
}
