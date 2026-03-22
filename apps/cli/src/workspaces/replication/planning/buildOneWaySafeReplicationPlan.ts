import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { WorkspaceReplicationBaselineRecord } from '../baseline/workspaceReplicationBaselineStore';
import {
    buildBaselineManifestComparison,
    type WorkspaceBaselineManifestComparison,
} from './buildBaselineManifestComparison';
import {
    compareWorkspaceManifests,
    type WorkspaceManifestComparison,
} from './compareWorkspaceManifests';
import type { WorkspaceReplicationMode } from '../relationships/relationshipScope';

type OneWaySafePolicy = Extract<WorkspaceReplicationMode, 'one_way_safe'>;

export type OneWaySafeReplicationPlan = Readonly<{
    policy: OneWaySafePolicy;
    baseline: WorkspaceReplicationBaselineRecord;
    sourceManifest: WorkspaceManifest;
    targetManifest: WorkspaceManifest;
    sourceComparison: WorkspaceBaselineManifestComparison;
    targetComparison: WorkspaceBaselineManifestComparison;
    targetDivergencePaths: readonly string[];
    blockingTargetDivergencePaths: readonly string[];
    hasTargetDivergence: boolean;
    canApplySafely: boolean;
}>;

function comparePaths(left: string, right: string): number {
    return left.localeCompare(right);
}

function collectComparisonPaths(comparison: WorkspaceBaselineManifestComparison): readonly string[] {
    return [
        ...comparison.added.map((entry) => entry.relativePath),
        ...comparison.removed.map((entry) => entry.relativePath),
        ...comparison.changed.map((entry) => entry.next.relativePath),
    ].sort(comparePaths);
}

function collectTransferPaths(comparison: WorkspaceManifestComparison): ReadonlySet<string> {
    return new Set([
        ...comparison.added.map((entry) => entry.relativePath),
        ...comparison.removed.map((entry) => entry.relativePath),
        ...comparison.changed.map((entry) => entry.next.relativePath),
    ]);
}

export function buildOneWaySafeReplicationPlan(params: Readonly<{
    baseline: WorkspaceReplicationBaselineRecord;
    sourceManifest: WorkspaceManifest;
    targetManifest: WorkspaceManifest;
}>): OneWaySafeReplicationPlan {
    const sourceComparison = buildBaselineManifestComparison({
        baseline: params.baseline,
        currentManifest: params.sourceManifest,
    });
    const targetComparison = buildBaselineManifestComparison({
        baseline: params.baseline,
        currentManifest: params.targetManifest,
    });
    const sourceTransferComparison = compareWorkspaceManifests({
        previousManifest: params.targetManifest,
        nextManifest: params.sourceManifest,
    });
    const targetDivergencePaths = collectComparisonPaths(targetComparison);
    const transferPaths = collectTransferPaths(sourceTransferComparison);
    const blockingTargetDivergencePaths = targetDivergencePaths.filter((relativePath) => transferPaths.has(relativePath));

    return {
        policy: 'one_way_safe',
        baseline: params.baseline,
        sourceManifest: params.sourceManifest,
        targetManifest: params.targetManifest,
        sourceComparison,
        targetComparison,
        targetDivergencePaths,
        blockingTargetDivergencePaths,
        hasTargetDivergence: targetComparison.hasChangesSinceBaseline,
        canApplySafely: blockingTargetDivergencePaths.length === 0,
    };
}
