import * as React from 'react';
import { type StyleProp, type ViewStyle, View } from 'react-native';

import { useLayoutMaxWidth } from '@/components/ui/layout/layout';

type ConstrainedScreenContentProps = Readonly<{
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
}>;

export const ConstrainedScreenContent = React.memo((props: ConstrainedScreenContentProps) => {
    const maxWidth = useLayoutMaxWidth();

    return (
        <View style={[{ width: '100%', maxWidth, alignSelf: 'center' }, props.style]}>
            {props.children}
        </View>
    );
});
