import * as React from 'react';
import { resolveFilesystemErrorReason } from '@/components/ui/filesystemBrowser/filesystemErrorReason';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/** Files failures belong here, including an unresolved target before any directory read. */
export function RepositoryTreeRootErrorState(props: Readonly<{
    /** The machine the files live on, so the title says where the listing failed. */
    machineName?: string | null;
    onRetry: () => void;
}> & (Readonly<{ kind?: 'error'; error: string }> | Readonly<{ kind: 'unavailable'; error?: never }>)) {
    const reason = props.kind === 'unavailable'
        ? t('files.pane.workspaceUnavailableReason')
        : resolveFilesystemErrorReason(props.error);

    return <SurfaceStateCard
        testID="repository-tree-root-error"
        kind={props.kind ?? 'error'}
        iconName="folder"
        title={props.machineName
            ? t('files.pane.rootErrorTitle', { machine: props.machineName })
            : t('files.pane.rootErrorTitleUnnamed')}
        reason={reason}
        diagnosticCode={props.error}
        action={{ label: t('common.retry'), onPress: props.onRetry }}
    />;
}
