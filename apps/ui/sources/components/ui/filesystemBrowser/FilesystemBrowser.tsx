import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { FilesystemBrowserList } from './FilesystemBrowserList';
import { resolveFilesystemErrorReason } from './filesystemErrorReason';
import type { FilesystemBrowserListProps } from './filesystemBrowserTypes';
import type { IconName } from '@/components/ui/icons/Icon';

export type FilesystemBrowserProps = FilesystemBrowserListProps & Readonly<{
    loadingTestID?: string;
    errorTestID?: string;
    emptyTestID?: string;
    emptyLabel: string;
    emptyIconName?: IconName;
    loadingLabelCentered?: string;
    retryLabel?: string;
}>;

export function FilesystemBrowser(props: FilesystemBrowserProps): React.ReactElement {
    const retryLabel = props.retryLabel ?? props.inlineRetryLabel;
    const centeredLoadingLabel = props.loadingLabelCentered ?? props.loadingLabel;
    const retainListComposition = (state: React.ReactElement) => props.listHeader || props.listFooter || props.listEmpty
        ? <FilesystemBrowserList {...props} listEmpty={props.listEmpty ?? state} /> : state;

    if (props.listEmpty && props.nodes.length === 0) return retainListComposition(props.listEmpty);

    // The browser's root states are the shared state composition, sized by the pane or modal around it.
    if (props.rootLoading && props.nodes.length === 0) {
        return retainListComposition(<SurfaceStateCard testID={props.loadingTestID} kind="loading" title={centeredLoadingLabel} />);
    }

    if (props.rootError && props.nodes.length === 0) {
        return retainListComposition(
            <SurfaceStateCard
                testID={props.errorTestID}
                kind="error"
                title={t('files.pane.rootErrorTitleUnnamed')}
                reason={props.rootErrorReason ?? resolveFilesystemErrorReason(props.rootError)}
                diagnosticCode={props.rootError}
                action={{ label: retryLabel, onPress: () => { void props.retryRoot(); } }}
            />
        );
    }

    if (props.nodes.length === 0) {
        return retainListComposition(
            <SurfaceStateCard
                testID={props.emptyTestID}
                kind="empty"
                iconName={props.emptyIconName ?? 'folder'}
                title={props.emptyLabel}
            />
        );
    }

    return <FilesystemBrowserList {...props} />;
}
