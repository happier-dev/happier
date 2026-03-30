export {
    createWorkspaceCheckoutWithSourceController,
    materializeWorkspaceCheckoutWithSourceController,
    realizeWorkspaceCheckoutWithSourceController,
} from './sourceController/workspaceCheckoutOperations';
export {
    assertPortableWorkspaceTransferEntriesWithSourceController,
    buildWorkspaceExportManifestWithSourceController,
    buildWorkspaceExportArtifactsWithBlobProviderFromSourceController,
    buildWorkspaceExportArtifactsWithSourceController,
    classifyPortableWorkspaceTransferEntryWithSourceController,
    resolveWorkspaceReplicationSourceInputsWithSourceController,
    resolveWorkspaceTransferEntriesWithSourceController,
    resolveWorkspaceTransferMetadataWithSourceController,
    resolveWorkspaceTransferWithSourceController,
} from './sourceController/workspaceTransferResolution';
export {
    inspectWorkspaceLocationWithSourceController,
    type ScmSourceControllerWorkspaceLocationResult,
} from './sourceController/workspaceLocationInspection';
export {
    reconcilePostMaterializationWithSourceController,
} from './sourceController/workspacePostMaterialization';
export {
    applyWorkspaceSyncArtifacts,
} from './sourceController/applyWorkspaceSyncArtifacts';
export {
    createWorkspaceSyncArtifacts,
    createWorkspaceSyncArtifactsFromManifest,
    type WorkspaceSyncArtifacts,
} from './sourceController/workspaceSyncArtifacts';
export {
    assertPortableWorkspaceEntriesWithSourceController,
    classifyPortableWorkspacePathWithSourceController,
    isAdministrativeWorkspacePathWithSourceController,
} from './sourceController/workspacePortability';
