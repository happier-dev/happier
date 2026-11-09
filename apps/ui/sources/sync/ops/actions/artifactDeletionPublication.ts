import { readWidgetSurfaceArtifactHeaderV1 } from '@happier-dev/protocol/widgets';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { storage } from '@/sync/domains/state/storage';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { t } from '@/text';

/** One acknowledged delete publication for the Project menu, Artifact page, panes and Actions. */
export function publishArtifactDeletion(artifactId: string, artifact: DecryptedArtifact | undefined): void {
    const dashboard = artifact && readWidgetSurfaceArtifactHeaderV1({ artifactId, header: artifact.rawHeader ?? artifact.header });
    if (dashboard) {
        if (dashboard.surface.owner.kind === 'project') {
            publishPresentationNotice({ key: `dashboard-deleted:${artifactId}`,
                message: t('projects.dashboard.deleted', { name: dashboard.title }), severity: 'info' });
        }
    }
    storage.getState().deleteArtifact(artifactId);
}
