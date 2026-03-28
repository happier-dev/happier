import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, type View } from 'react-native';

import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export function createPathActionChip(params: Readonly<{
    anchorRef?: React.RefObject<View | null>;
    currentPath?: string | null;
    tint: string;
    showLabel: boolean;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    onPress: () => void;
}>): React.ReactNode {
    const label = typeof params.currentPath === 'string' && params.currentPath.length > 0
        ? params.currentPath
        : t('newSession.selectPathTitle');

    return (
        <Pressable
            ref={params.anchorRef}
            key="path"
            testID="agent-input-path-chip"
            onPress={params.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => params.chipStyle(state.pressed)}
        >
            {normalizeNodeForView(<Ionicons name="folder-outline" size={18} color={params.tint} />)}
            {/*
             * Path selection stays label-visible even when chip density is icon-only.
             * This keeps the selected folder/path readable on mobile layouts.
             */}
            <Text numberOfLines={1} ellipsizeMode="middle" style={params.textStyle}>
                {label}
            </Text>
        </Pressable>
    );
}
