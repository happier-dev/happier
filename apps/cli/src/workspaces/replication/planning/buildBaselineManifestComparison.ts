import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { WorkspaceReplicationBaselineRecord } from '../baseline/workspaceReplicationBaselineStore';

import {
    compareWorkspaceManifests,
    type WorkspaceManifestComparison,
} from './compareWorkspaceManifests';

export type WorkspaceBaselineManifestComparison = Readonly<{
    baseline: WorkspaceReplicationBaselineRecord;
    baselineManifest: WorkspaceManifest;
    currentManifest: WorkspaceManifest;
    added: WorkspaceManifestComparison['added'];
    removed: WorkspaceManifestComparison['removed'];
    changed: WorkspaceManifestComparison['changed'];
    unchanged: WorkspaceManifestComparison['unchanged'];
    hasChangesSinceBaseline: boolean;
}>;

export function buildBaselineManifestComparison(params: Readonly<{
    baseline: WorkspaceReplicationBaselineRecord;
    currentManifest: WorkspaceManifest;
}>): WorkspaceBaselineManifestComparison {
    const baselineManifest = params.baseline.manifest;
    const comparison = compareWorkspaceManifests({
        previousManifest: baselineManifest,
        nextManifest: params.currentManifest,
    });

    return {
        baseline: params.baseline,
        baselineManifest,
        currentManifest: params.currentManifest,
        added: comparison.added,
        removed: comparison.removed,
        changed: comparison.changed,
        unchanged: comparison.unchanged,
        hasChangesSinceBaseline: comparison.hasChanges,
    };
}
