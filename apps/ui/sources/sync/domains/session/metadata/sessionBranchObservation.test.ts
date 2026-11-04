import { describe, expect, it } from 'vitest';
import { applyObservedSessionBranch } from './sessionBranchObservation';

const metadata = { machineId: 'machine', path: '/repo/packages/app', branch: 'old', host: 'host' };
const observation = { machineId: 'machine', path: '/repo/packages/app', rootPath: '/repo', branch: { head: 'actual', detached: false } };

describe('demanded Session checkout branch observations', () => {
    it('updates only the observed branch, preserves concurrent fields, and does no work for equal observations', () => {
        const next = applyObservedSessionBranch(metadata, observation);
        expect(next).toEqual({ ...metadata, branch: 'actual' });
        expect(applyObservedSessionBranch(next, observation)).toBe(next);
        const renamed = { ...metadata, name: 'Concurrent rename' };
        expect(applyObservedSessionBranch(renamed, observation)).toEqual({ ...renamed, branch: 'actual' });
        const detached = applyObservedSessionBranch(next, { ...observation, branch: { head: null, detached: true } });
        expect(detached).toHaveProperty('branch', null);
    });

    it('retains unknown observations and refuses another Machine, checkout, or a moved Session', () => {
        for (const other of [
            { ...observation, machineId: 'other-machine' },
            { ...observation, path: '/another-checkout' },
            { ...observation, rootPath: '/repo-sibling' },
            { ...observation, branch: { head: null, detached: false } },
        ]) expect(applyObservedSessionBranch(metadata, other)).toBe(metadata);
        const moved = { ...metadata, path: '/moved' };
        expect(applyObservedSessionBranch(moved, observation)).toBe(moved);
    });

    it('uses the canonical sandbox Machine path and Windows path comparison', () => {
        const sandbox = { ...metadata, path: '/container/app', sessionWorkspaceLocationV1: { v: 1 as const,
            machineId: 'machine', agentPath: '/container/app', machinePath: 'C:\\Repo\\packages\\app' } };
        expect(applyObservedSessionBranch(sandbox, { ...observation, path: 'c:/repo/packages/app', rootPath: 'C:\\Repo' }))
            .toHaveProperty('branch', 'actual');
        expect(applyObservedSessionBranch(sandbox, { ...observation, path: 'c:/repo2/packages/app', rootPath: 'C:\\Repo2' })).toBe(sandbox);
    });
});
