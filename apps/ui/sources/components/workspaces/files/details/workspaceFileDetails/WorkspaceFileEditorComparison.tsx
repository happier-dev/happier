import * as React from 'react';
import { View } from 'react-native';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { Modal } from '@/modal';
import { t } from '@/text';

type ComparisonProps = Readonly<{ oldText: string; newText: string; filePath: string }>;

function WorkspaceFileEditorComparison(props: ComparisonProps) {
    return (
        <View style={{ flex: 1, minHeight: 240 }}>
            <DiffViewer mode="text" {...props} wrapLines showLineNumbers showPrefix />
        </View>
    );
}

/** Read-only comparison: the latest disk version against the live draft, without reseeding it. */
export function showWorkspaceFileEditorComparison(props: ComparisonProps) {
    Modal.show({
        component: WorkspaceFileEditorComparison,
        props,
        chrome: {
            kind: 'card',
            title: props.filePath,
            subtitle: t('files.fileChangedExternally'),
            scrollHost: 'body',
            bodyScroll: 'none',
            dimensions: { width: 900, maxHeightRatio: 0.85, size: 'lg' },
        },
    });
}
