import type { DecryptedArtifact } from './artifactTypes';

export type ArtifactAccessCapabilities = Readonly<{
    canEdit: boolean;
    canManage: boolean;
    canShare: boolean;
}>;

/** Access omitted by retained legacy artifacts keeps their existing edit/manage capabilities. */
export function readArtifactAccessCapabilities(access: DecryptedArtifact['access']): ArtifactAccessCapabilities {
    return {
        canEdit: access === undefined || access === 'owner' || access === 'edit' || access === 'admin',
        canManage: access === undefined || access === 'owner' || access === 'admin',
        canShare: access === 'owner' || access === 'admin',
    };
}
