import { describe, expect, it } from 'vitest';
import { resolveDefaultDiffModeForFile } from '@/scm/diff/defaultMode';

const gitSnapshot = {
    repo: { backendId: 'git' },
    capabilities: { writeInclude: true, writeExclude: true },
} as any;

const saplingSnapshot = {
    repo: { backendId: 'sapling' },
    capabilities: { writeInclude: false, writeExclude: false },
} as any;

describe('resolveDefaultDiffModeForFile', () => {
    it('uses backend override when both included and pending deltas exist', () => {
        const mode = resolveDefaultDiffModeForFile({
            snapshot: gitSnapshot,
            backendOverrides: { git: 'included' },
            hasIncludedDelta: true,
            hasPendingDelta: true,
        });
        expect(mode).toBe('included');
    });

    it('falls back to pending when only pending delta exists', () => {
        const mode = resolveDefaultDiffModeForFile({
            snapshot: gitSnapshot,
            backendOverrides: { git: 'included' },
            hasIncludedDelta: false,
            hasPendingDelta: true,
        });
        expect(mode).toBe('pending');
    });

    it('uses sapling default when no override is provided', () => {
        const mode = resolveDefaultDiffModeForFile({
            snapshot: saplingSnapshot,
            backendOverrides: {},
            hasIncludedDelta: false,
            hasPendingDelta: true,
        });
        expect(mode).toBe('pending');
    });
});
