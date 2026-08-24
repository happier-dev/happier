export {
    createWorkspaceCheckoutWithScmWorkspace,
    materializeWorkspaceCheckoutWithScmWorkspace,
    realizeWorkspaceCheckoutWithResolvedScmSelection,
    realizeWorkspaceCheckoutWithScmWorkspace,
} from './workspace/workspaceCheckoutOperations';
export {
    assertPortableWorkspaceTransferEntriesWithScmWorkspace,
    buildWorkspaceExportManifestWithScmWorkspace,
    buildWorkspaceExportArtifactsWithBlobProviderFromWorkspaceIntegration,
    buildWorkspaceExportArtifactsWithScmWorkspace,
    classifyPortableWorkspaceTransferEntryWithScmWorkspace,
    resolveWorkspaceReplicationSourceInputsWithScmWorkspace,
    resolveWorkspaceTransferEntriesWithScmWorkspace,
    resolveWorkspaceTransferMetadataWithScmWorkspace,
    resolveWorkspaceTransferWithScmWorkspace,
} from './workspace/workspaceTransferResolution';
export {
    inspectWorkspaceLocationWithScmWorkspace,
    type ScmWorkspaceIntegrationWorkspaceLocationResult,
} from './workspace/workspaceLocationInspection';
export {
    reconcilePostMaterializationWithScmWorkspace,
} from './workspace/workspacePostMaterialization';
export {
    applyWorkspaceSyncArtifacts,
} from './workspace/applyWorkspaceSyncArtifacts';
export {
    createWorkspaceSyncArtifacts,
    createWorkspaceSyncArtifactsFromManifest,
    type WorkspaceSyncArtifacts,
} from './workspace/workspaceSyncArtifacts';
export {
    assertPortableWorkspaceEntriesWithScmWorkspace,
    classifyPortableWorkspacePathWithScmWorkspace,
    isAdministrativeWorkspacePathWithScmWorkspace,
} from './workspace/workspacePortability';
