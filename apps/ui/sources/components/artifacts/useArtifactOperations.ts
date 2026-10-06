import * as React from 'react';
import { getArtifactUseTargetV1 } from '@happier-dev/protocol';

import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Modal } from '@/modal';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';

import { useArtifactActionsClient } from './artifactActionsClient';
import { artifactViewRoute, classifyArtifactBrowserKind } from './artifactBrowserModel';
import { artifactKindLabel } from './artifactKindPresentation';
import { showArtifactHistorySheet } from './ArtifactHistorySheet';

/** The same access, sharing, history and confirmed delete operations for a row, pane and page. */
export function useArtifactOperations(artifact: DecryptedArtifact, onDeleted: () => void) {
    const client = useArtifactActionsClient();
    const scope = useActiveServerAccountScope();
    const router = useRouter();
    const [deleting, setDeleting] = React.useState(false);
    const canRead = artifact.isDecrypted !== false;
    const canEdit = canRead && (artifact.access === undefined || artifact.access === 'owner' || artifact.access === 'edit' || artifact.access === 'admin');
    const canManage = canRead && (artifact.access === undefined || artifact.access === 'owner' || artifact.access === 'admin');
    const header = artifact.rawHeader ?? artifact.header ?? {};
    const canShare = canManage && getArtifactUseTargetV1({ artifactId: artifact.id, header, body: null }).canShare;
    const name = artifact.title || t('artifacts.untitled');
    const share = () => {
        if (!canShare) return;
        showDocumentShareSheet({ artifactId: artifact.id, kind: typeof header.kind === 'string' ? header.kind : null,
            name, subtitle: artifactKindLabel(classifyArtifactBrowserKind(artifact) ?? 'document'), linkPath: artifactViewRoute(artifact.id) });
    };
    const history = () => {
        if (canRead) showArtifactHistorySheet({ artifactId: artifact.id, name, canRestore: canEdit });
    };
    const remove = async () => {
        if (!canManage || deleting) return;
        const confirmed = await Modal.confirm(t('artifacts.deleteConfirm'), t('artifacts.deleteConfirmDescription'), {
            confirmText: t('artifacts.delete'), destructive: true,
        });
        if (!confirmed) return;
        setDeleting(true);
        try {
            // Header-only list rows must resolve their body revision through the existing read owner.
            const current = artifact.bodyVersion === undefined ? await sync.fetchArtifactWithBody(artifact.id) : artifact;
            if (!client || !current || current.bodyVersion === undefined) throw new Error('artifact_content_unavailable');
            const outcome = await client.deleteArtifact({ artifactId: artifact.id,
                expectedRevision: { headerVersion: current.headerVersion, bodyVersion: current.bodyVersion } });
            if ('approvalId' in outcome) {
                if (scope) router.push(`/inbox/approvals/${encodeURIComponent(outcome.approvalId)}?serverId=${encodeURIComponent(scope.serverId)}` as never);
                return;
            }
            if (!outcome.ok) throw new Error(outcome.failure.code);
            onDeleted();
        } catch {
            Modal.alert(t('common.error'), t('artifacts.deleteError'));
        } finally {
            setDeleting(false);
        }
    };
    return { canRead, canEdit, canManage, canShare, deleting, share, history, remove };
}
