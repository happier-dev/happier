import * as React from 'react';
import { ExternalFileDropOutcomePill } from '@/components/ui/treeDragDrop/ui/ExternalFileDropOutcomePill';
import { t } from '@/text';

export function RepositoryTreeDropOverlay(props: Readonly<{ visible: boolean; destinationLabel?: string | null }>) {
    if (!props.visible) return null;
    return (
        <ExternalFileDropOutcomePill testID="repository-tree-drop-overlay" outcome={{
                tone: 'allowed',
                glyph: 'upload',
                title: t('entityDragDrop.files.uploadHere'),
                detail: props.destinationLabel || undefined,
            }} />
    );
}
