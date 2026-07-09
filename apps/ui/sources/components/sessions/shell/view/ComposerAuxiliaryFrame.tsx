import * as React from 'react';
import { View } from 'react-native';

import { COMPOSER_CONTENT_HORIZONTAL_INSET } from '@/components/sessions/agentInput/composerContentInset';
import { layout } from '@/components/ui/layout/layout';

export function ComposerAuxiliaryFrame(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    return (
        <View style={{ width: '100%', alignItems: 'center', paddingHorizontal: COMPOSER_CONTENT_HORIZONTAL_INSET, paddingTop: 8 }}>
            <View style={{ width: '100%', maxWidth: layout.maxWidth }}>
                {props.children}
            </View>
        </View>
    );
}
