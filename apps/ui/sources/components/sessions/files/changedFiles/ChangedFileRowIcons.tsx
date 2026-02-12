import * as React from 'react';
import { Octicons } from '@expo/vector-icons';

import { FileIcon } from '@/components/ui/media/FileIcon';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export function ChangedFileIcon(props: { file: ScmFileStatus }): React.ReactElement {
    return <FileIcon fileName={props.file.fileName} size={32} />;
}

export function ChangedFileStatusIcon(props: {
    file: ScmFileStatus;
    theme: any;
    isDarkTheme: boolean;
}): React.ReactElement | null {
    const { file, theme, isDarkTheme } = props;

    let statusColor: string;
    let statusIcon: string;

    switch (file.status) {
        case 'modified':
            statusColor = theme?.colors?.warning ?? '#FF9500';
            statusIcon = 'diff-modified';
            break;
        case 'added':
            statusColor = theme?.colors?.success ?? '#34C759';
            statusIcon = 'diff-added';
            break;
        case 'deleted':
            statusColor = theme?.colors?.textDestructive ?? '#FF3B30';
            statusIcon = 'diff-removed';
            break;
        case 'renamed':
            statusColor = theme?.colors?.textLink ?? '#007AFF';
            statusIcon = 'arrow-right';
            break;
        case 'copied':
            statusColor = theme?.colors?.textLink ?? '#007AFF';
            statusIcon = 'copy';
            break;
        case 'conflicted':
            statusColor = theme?.colors?.textDestructive ?? '#FF3B30';
            statusIcon = 'alert';
            break;
        case 'untracked':
            statusColor = theme?.colors?.textSecondary ?? (isDarkTheme ? '#b0b0b0' : '#8E8E93');
            statusIcon = 'file';
            break;
        default:
            return null;
    }

    return <Octicons name={statusIcon as any} size={16} color={statusColor} />;
}

