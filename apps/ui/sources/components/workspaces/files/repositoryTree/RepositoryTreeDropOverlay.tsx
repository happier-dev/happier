import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { EntityReleaseOutcomePill } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { t } from '@/text';
const stylesheet = StyleSheet.create(() => ({
    overlay: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
    },
}));

export function RepositoryTreeDropOverlay(props: Readonly<{ visible: boolean; destinationLabel?: string | null }>) {
    if (!props.visible) return null;
    return (
        <View testID="repository-tree-drop-overlay" pointerEvents="none" style={stylesheet.overlay}>
            <EntityReleaseOutcomePill outcome={{
                tone: 'allowed',
                glyph: 'upload',
                title: t('entityDragDrop.files.uploadHere'),
                detail: props.destinationLabel || undefined,
            }} />
        </View>
    );
}
