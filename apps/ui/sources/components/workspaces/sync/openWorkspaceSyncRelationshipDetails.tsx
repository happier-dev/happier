import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import * as React from 'react';

import type { CustomModalInjectedProps } from '@/modal';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { WorkspaceSyncRelationshipSummary } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';

import {
    WorkspaceSyncConflictDetailsView,
    type WorkspaceSyncConflictDetailsResource,
} from './WorkspaceSyncConflictDetailsView';
import { createWorkspaceSyncConflictDetailsResource } from './workspaceSyncConflictDetailsTab';
import { formatWorkspaceSyncRelationshipTitle } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

type WorkspaceSyncRelationshipDetailsModalProps = CustomModalInjectedProps & Readonly<{
    resource: WorkspaceSyncConflictDetailsResource;
}>;

function WorkspaceSyncRelationshipDetailsModal(props: WorkspaceSyncRelationshipDetailsModalProps) {
    useCurrentUiContextLocalCommands([{ key: 'close', title: t('common.close'), invoke: props.onClose }]);
    return <WorkspaceSyncConflictDetailsView resource={props.resource} />;
}

/**
 * Modal-only adapter for surfaces that do not own a details pane. The existing
 * workspace-sync resource builder, renderer, stores, and operations remain the
 * single relationship detail owner.
 */
export function openWorkspaceSyncConflictDetails(resource: WorkspaceSyncConflictDetailsResource, title?: string): void {
    Modal.show({
        component: WorkspaceSyncRelationshipDetailsModal,
        props: { resource },
        accessibilityLabel: t('workspaceSync.title'),
        closeOnBackdrop: true,
        chrome: {
            kind: 'card',
            title: title ?? t('workspaceSync.conflictsTitle'),
            // A link's sheet is already titled by its folders; the section says "Workspace sync" once, inside.
            subtitle: title ? undefined : t('workspaceSync.title'),
            // The details view owns its responsive scroll surface. A second modal
            // scroller traps narrow/large-text content and can strand actions.
            bodyScroll: 'none',
            testID: 'workspace-sync-relationship-details-modal',
            dimensions: { size: 'md', width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.92 },
        },
    });
}

export function openWorkspaceSyncRelationshipDetails(
    summary: WorkspaceSyncRelationshipSummary,
    localWorkspaceRefId?: string | null,
): void {
    const resource = createWorkspaceSyncConflictDetailsResource(summary, localWorkspaceRefId);
    openWorkspaceSyncConflictDetails(resource, formatWorkspaceSyncRelationshipTitle({
        alphaLabel: summary.alpha.name,
        betaLabel: summary.beta.name,
        mode: summary.relationship.mode,
    }));
}
