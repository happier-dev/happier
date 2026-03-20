import type { ScmSourceControllerWorkspaceExportArtifacts } from '@/scm/sourceController/workspaceExportArtifacts';

import type { SessionHandoffProviderBundle } from '../types';

export type SessionHandoffTransferredArtifact = Readonly<
    | {
        kind: 'provider_bundle';
        providerBundle: SessionHandoffProviderBundle;
      }
    | {
        kind: 'workspace_export_artifacts';
        workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts;
      }
>;

export type SessionHandoffTransferredArtifactKind = SessionHandoffTransferredArtifact['kind'];
