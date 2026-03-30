import { describe, expect, it } from 'vitest';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import type { WorkspaceReplicationBaselineRecord } from '../baseline/workspaceReplicationBaselineStore';

import { buildOneWaySafeReplicationPlan } from './buildOneWaySafeReplicationPlan';

function createManifest(entries: WorkspaceManifest['entries']): WorkspaceManifest {
    return { entries };
}

function createBaseline(manifest: WorkspaceManifest): WorkspaceReplicationBaselineRecord {
    return {
        manifestFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        manifest,
        savedAtMs: 123,
    };
}

describe('buildOneWaySafeReplicationPlan', () => {
    it('blocks when the target diverged on a path the source would overwrite', () => {
        const baseline = createBaseline(createManifest([
            {
                kind: 'file',
                relativePath: 'README.md',
                digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
                executable: false,
                sizeBytes: 10,
            },
            {
                kind: 'file',
                relativePath: 'package.json',
                digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
                executable: false,
                sizeBytes: 20,
            },
        ]));

        const sourceManifest = createManifest([
            {
                kind: 'file',
                relativePath: 'README.md',
                digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
                executable: false,
                sizeBytes: 14,
            },
            {
                kind: 'file',
                relativePath: 'package.json',
                digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
                executable: false,
                sizeBytes: 20,
            },
        ]);

        const targetManifest = createManifest([
            {
                kind: 'file',
                relativePath: 'README.md',
                digest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
                executable: false,
                sizeBytes: 12,
            },
            {
                kind: 'file',
                relativePath: 'package.json',
                digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
                executable: false,
                sizeBytes: 20,
            },
        ]);

        const plan = buildOneWaySafeReplicationPlan({ baseline, sourceManifest, targetManifest });

        expect(plan.policy).toBe('one_way_safe');
        expect(plan.targetDivergencePaths).toEqual(['README.md']);
        expect(plan.blockingTargetDivergencePaths).toEqual(['README.md']);
        expect(plan.hasTargetDivergence).toBe(true);
        expect(plan.canApplySafely).toBe(false);
    });

    it('allows applying when the target diverged only on paths the source already matches', () => {
        const baseline = createBaseline(createManifest([
            {
                kind: 'file',
                relativePath: 'README.md',
                digest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
                executable: false,
                sizeBytes: 10,
            },
            {
                kind: 'file',
                relativePath: 'notes.txt',
                digest: 'sha256:6666666666666666666666666666666666666666666666666666666666666666',
                executable: false,
                sizeBytes: 8,
            },
        ]));

        const targetManifest = createManifest([
            {
                kind: 'file',
                relativePath: 'README.md',
                digest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
                executable: false,
                sizeBytes: 10,
            },
            {
                kind: 'file',
                relativePath: 'notes.txt',
                digest: 'sha256:7777777777777777777777777777777777777777777777777777777777777777',
                executable: false,
                sizeBytes: 12,
            },
        ]);

        const sourceManifest = createManifest(targetManifest.entries);

        const plan = buildOneWaySafeReplicationPlan({ baseline, sourceManifest, targetManifest });

        expect(plan.targetDivergencePaths).toEqual(['notes.txt']);
        expect(plan.blockingTargetDivergencePaths).toEqual([]);
        expect(plan.hasTargetDivergence).toBe(true);
        expect(plan.canApplySafely).toBe(true);
    });
});
