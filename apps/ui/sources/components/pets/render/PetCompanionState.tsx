import * as React from 'react';
import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import type { PetAnimationStateV1 } from '@happier-dev/protocol';

type PetCompanionStateDataProps = ViewProps & Readonly<{
    dataSet: Readonly<{ petState: PetAnimationStateV1 }>;
    'data-pet-state': PetAnimationStateV1;
}>;

export type PetCompanionStateProps = Readonly<{
    state: PetAnimationStateV1;
    children?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}>;

export function PetCompanionState(props: PetCompanionStateProps): React.ReactElement {
    const dataProps: PetCompanionStateDataProps = {
        testID: 'pet-companion-state',
        dataSet: { petState: props.state },
        'data-pet-state': props.state,
        style: props.style,
    };

    return (
        <View {...dataProps}>
            {props.children}
        </View>
    );
}
