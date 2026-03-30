import * as React from 'react';
import { ActivityIndicator, Pressable } from 'react-native';
import { Octicons } from '@expo/vector-icons';

import { Shaker, type ShakeInstance } from '@/components/ui/feedback/Shaker';
import { t } from '@/text';

export function createAbortActionButton(params: Readonly<{
    shakerRef: React.RefObject<ShakeInstance | null>;
    isAborting: boolean;
    tint: string;
    buttonStyle: any;
    buttonPressedStyle: any;
    onPress: () => void;
}>): React.ReactNode {
    return (
        <Shaker key="abort" ref={params.shakerRef}>
            <Pressable
                testID="agent-input-abort"
                accessibilityRole="button"
                accessibilityLabel={t('runs.stop.stopRunA11y')}
                style={(state) => [
                    params.buttonStyle,
                    state.pressed ? params.buttonPressedStyle : null,
                ]}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                onPress={params.onPress}
                disabled={params.isAborting}
            >
                {params.isAborting ? (
                    <ActivityIndicator size="small" color={params.tint} />
                ) : (
                    <Octicons name="stop" size={16} color={params.tint} />
                )}
            </Pressable>
        </Shaker>
    );
}
