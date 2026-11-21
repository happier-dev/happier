import * as React from 'react';
import { getArtifactKindPolicyV1, getArtifactUseTargetV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { readWidgetSurfaceArtifactV1, WIDGET_SURFACE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/widgets';

import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import type { ShareSheetAnchor } from '@/components/sharing/presentShareSheet';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { Modal } from '@/modal';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { readArtifactAccessCapabilities } from '@/sync/domains/artifacts/artifactAccessCapabilities';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { resolveActionExecutionErrorMessage, resolveActionExecutionFailureTitle } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { readWidgetAreaLayoutDeleteProtectionV1 } from '@/sync/ops/actions/widgetAreaActionDeps';
import { confirmDashboardDelete } from '@/components/projects/overview/confirmDashboardDelete';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useCurrentUiContextCommandBridge } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

import { createArtifactActionsClient, createMountedArtifactActionExecute } from './artifactActionsClient';
import { artifactViewRoute, classifyArtifactViewKind } from './artifactBrowserModel';
import { artifactKindLabel } from './artifactKindPresentation';
import { showArtifactHistorySheet } from './ArtifactHistorySheet';
import { presentArtifactActionFailure } from './artifactActionFailure';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';

/** The same access, sharing, history and confirmed delete operations for a row, pane and page. */
export function useArtifactOperations(artifact: DecryptedArtifact | null, onDeleted?: () => void) {
    const commandBridge = useCurrentUiContextCommandBridge();
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    const mounted = useMountedActionExecution(scope);
    const client = React.useMemo(() => scope ? createArtifactActionsClient(scope,
        createMountedArtifactActionExecute(mounted.execute)) : null, [scope, mounted.execute]);
    const [deleting, setDeleting] = React.useState(false);
    const canRead = artifact !== null && artifact.isDecrypted !== false;
    const access = readArtifactAccessCapabilities(artifact?.access);
    const canEdit = canRead && access.canEdit;
    const canManage = canRead && access.canManage;
    const header = artifact?.rawHeader ?? artifact?.header ?? {};
    const sharing = getArtifactKindPolicyV1(header.kind);
    // A kind its owner lets people share and open by its address (a Review) is shared from its own page even when the
    // Artifacts browser does not list it; a kind shared through its own owner's flow (a Deployment) is not.
    const canShare = canRead && access.canShare
        && (sharing.browserListed || (sharing.peopleSharingAllowed && sharing.addressedReadAllowed)
            || classifyArtifactViewKind(artifact) === 'dashboard'
            || getArtifactUseTargetV1({ artifactId: artifact.id, header, body: artifact.body ?? null }, 'signed_in').publicLinkAllowed)
        && (sharing.peopleSharingAllowed || sharing.publicLinkAllowed);
    const name = artifact?.title || t('artifacts.untitled');
    /** `anchor`: the Share control (or ⋯) it came from; the sheet hangs from it on wide layouts. */
    const share = (anchor?: ShareSheetAnchor) => {
        if (!artifact || !canShare) return;
        showDocumentShareSheet({ artifactId: artifact.id, kind: typeof header.kind === 'string' ? header.kind : null,
            kindLabel: artifactKindLabel(classifyArtifactViewKind(artifact)),
            name, linkPath: artifactViewRoute(artifact.id), ...(anchor ? { anchor } : {}) });
    };
    /** `acceptedVersions`: the versions accepted suggestions made, when the caller reads the Doc's threads. */
    const history = (acceptedVersions?: ReadonlySet<number>) => {
        if (artifact && canRead) showArtifactHistorySheet({ artifactId: artifact.id, name, canRestore: canEdit, commandBridge,
            ...(acceptedVersions ? { acceptedVersions } : {}) });
    };
    const remove = async () => {
        if (!artifact || !canManage || deleting) return;
        const dashboard = header.kind === WIDGET_SURFACE_ARTIFACT_KIND_V1;
        let current: DecryptedArtifact | null = artifact;
        let layout: ReturnType<typeof readWidgetSurfaceArtifactV1> = null;
        if (dashboard) {
            // A dashboard's delete is the layout owner's: ask it before offering a confirmation that it would refuse.
            setDeleting(true);
            try {
                // Header-only list rows resolve their body revision through the existing read owner.
                current = artifact.bodyVersion === undefined || artifact.body === undefined ? await sync.fetchArtifactWithBody(artifact.id) : artifact;
                layout = current ? readWidgetSurfaceArtifactV1({ artifactId: artifact.id, header: current.rawHeader ?? current.header ?? {}, body: current.body ?? null }) : null;
                if (layout && current?.access === 'owner' && layout.surface.accountId === scope?.accountId
                    && await readWidgetAreaLayoutDeleteProtectionV1(layout.surface)) {
                    if (mounted.isCurrent()) Modal.alert(name, t('projects.dashboard.defaultProtected'));
                    return;
                }
            } catch (error) {
                if (mounted.isCurrent()) Modal.alert(resolveActionExecutionFailureTitle(error, t('common.error')), resolveActionExecutionErrorMessage(error, t('artifacts.deleteError')));
                return;
            } finally {
                if (mounted.isCurrent()) setDeleting(false);
            }
        }
        const confirmed = dashboard ? await confirmDashboardDelete(name)
            : await Modal.confirm(t('artifacts.deleteConfirm', { name }), t('artifacts.deleteConfirmDescription'), {
                confirmText: t('artifacts.delete'), destructive: true,
            });
        if (!confirmed || !mounted.isCurrent()) return;
        setDeleting(true);
        try {
            if (!dashboard && artifact.bodyVersion === undefined) current = await sync.fetchArtifactWithBody(artifact.id);
            if (!client || !current || current.bodyVersion === undefined) throw new Error('artifact_content_unavailable');
            const expectedRevision = { headerVersion: current.headerVersion, bodyVersion: current.bodyVersion };
            // Dashboard policy remains with the widget owner. Other callers retain generic internal-kind exclusion.
            const outcome = layout && current.access === 'owner' && layout.surface.accountId === scope?.accountId
                ? await client.deleteDashboard({ surface: layout.surface, expectedRevision }, { confirmed: true })
                : await client.deleteArtifact({ artifactId: artifact.id, expectedRevision }, { confirmed: true });
            if (!mounted.isCurrent() || 'approvalId' in outcome) return;
            if (!outcome.ok) {
                alertActionFailure(presentArtifactActionFailure(outcome.failure, t('artifacts.deleteError')));
                return;
            }
            if (onDeleted) onDeleted();
            else router.replace('/artifacts');
        } catch (error) {
            if (mounted.isCurrent()) Modal.alert(resolveActionExecutionFailureTitle(error, t('common.error')), resolveActionExecutionErrorMessage(error, t('artifacts.deleteError')));
        } finally {
            if (mounted.isCurrent()) setDeleting(false);
        }
    };
    return { canRead, canEdit, canManage, canShare, deleting, share, history, remove, approval: mounted.approval };
}
