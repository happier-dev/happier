import * as React from 'react';
import { Octicons } from '@expo/vector-icons';
import type { UnistylesThemes } from 'react-native-unistyles';

import { FileIcon } from '@/components/ui/media/FileIcon';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

type Theme = UnistylesThemes[keyof UnistylesThemes];
type OcticonsName = React.ComponentProps<typeof Octicons>['name'];

export function ChangedFileIcon(props: { file: ScmFileStatus; size?: number }): React.ReactElement {
    return <FileIcon fileName={props.file.fileName} size={props.size ?? 32} />;
}

export function ChangedFileStatusIcon(props: {
    file: ScmFileStatus;
    theme: Theme;
}): React.ReactElement | null {
    const { file, theme } = props;

    let statusColor: string;
    let statusIcon: OcticonsName;

    switch (file.status) {
        case 'modified':
            statusColor = theme.colors.state.neutral.foreground;
            statusIcon = 'diff-modified';
            break;
        case 'added':
            statusColor = theme.colors.state.success.foreground;
            statusIcon = 'diff-added';
            break;
        case 'deleted':
            statusColor = theme.colors.state.danger.foreground;
            statusIcon = 'diff-removed';
            break;
        case 'renamed':
            statusColor = theme.colors.text.link;
            statusIcon = 'arrow-right';
            break;
        case 'copied':
            statusColor = theme.colors.text.link;
            statusIcon = 'copy';
            break;
        case 'conflicted':
            statusColor = theme.colors.state.danger.foreground;
            statusIcon = 'alert';
            break;
        case 'untracked':
            statusColor = theme.colors.text.secondary;
            statusIcon = 'file';
            break;
        default:
            return null;
    }

    return <Octicons name={statusIcon} size={16} color={statusColor} />;
}
