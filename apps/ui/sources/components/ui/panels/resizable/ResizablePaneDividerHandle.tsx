import * as React from 'react';
import { Platform, Pressable, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { t } from '@/text';

export const ResizablePaneDividerHandle = React.memo((props: Readonly<{
    axis: 'x' | 'y';
    testID?: string;
    style?: StyleProp<ViewStyle>;
    showIndicator?: boolean;
    indicatorColor?: string;
    indicatorOpacity?: number;
    interactionProps?: Partial<PressableProps>;
}>) => {
    const showIndicator = props.showIndicator !== false && typeof props.indicatorColor === 'string';

    return (
        <Pressable
            testID={props.testID}
            focusable={Platform.OS === 'web'}
            accessibilityRole="adjustable"
            accessibilityLabel={t('ui.resizableDockedPane.resizeA11y')}
            accessibilityHint={t('ui.resizableDockedPane.resizeHint')}
            {...props.interactionProps}
            style={[
                {
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: props.axis === 'x' ? ('col-resize' as any) : ('row-resize' as any),
                    userSelect: 'none' as any,
                    ...(Platform.OS === 'web' ? ({ touchAction: 'none' } as any) : null),
                },
                props.style,
            ]}
        >
            {showIndicator ? (
                <View
                    style={props.axis === 'x'
                        ? {
                            width: 1,
                            height: '100%',
                            backgroundColor: props.indicatorColor,
                            opacity: props.indicatorOpacity ?? 1,
                        }
                        : {
                            width: 56,
                            height: 5,
                            borderRadius: 999,
                            backgroundColor: props.indicatorColor,
                            opacity: props.indicatorOpacity ?? 1,
                        }}
                />
            ) : null}
        </Pressable>
    );
});
