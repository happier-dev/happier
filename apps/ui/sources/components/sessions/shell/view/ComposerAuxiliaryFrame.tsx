import * as React from 'react';
import { View } from 'react-native';

import { layout } from '@/components/ui/layout/layout';

export function ComposerAuxiliaryFrame(props: Readonly<{ children: React.ReactNode; windowWidth: number }>): React.ReactElement {
    const horizontalPadding = props.windowWidth > 700 ? 16 : 8;

    return (
        <View style={{ width: '100%', alignItems: 'center', paddingHorizontal: horizontalPadding, paddingTop: 8 }}>
            <View style={{ width: '100%', maxWidth: layout.maxWidth }}>
                {props.children}
            </View>
        </View>
    );
}
