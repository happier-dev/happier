export type { WorkspaceManifest, WorkspaceManifestEntry } from '@happier-dev/protocol';

export {
    compareWorkspaceManifests,
} from '@/scm/sourceController/workspaceExportPackaging/compareWorkspaceManifests';

export type {
    WorkspaceManifestComparison,
    WorkspaceManifestEntryChange,
} from '@/scm/sourceController/workspaceExportPackaging/compareWorkspaceManifests';
