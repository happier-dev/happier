import { describe, expect, it } from 'vitest';

import { resolveContextualWorkflowProjectTarget } from './resolveContextualWorkflowTarget';

function machine(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        active: true,
        activeAt: Date.now(),
        seq: 1,
        metadata: { host: id, homeDir: `/home/${id}` },
        ...overrides,
    } as never;
}

/**
 * UX §2.3 — contextual defaults are truthful. Every case here exists to refute
 * the fabrication it forbids: a fixed default, a Machine with an invented
 * folder, or a target that looks complete while Run now still cannot proceed.
 */
describe('resolveContextualWorkflowProjectTarget', () => {
    it('uses the Account\'s most recent machine and folder, not a fixed default', () => {
        expect(resolveContextualWorkflowProjectTarget({
            machines: [machine('machine-a'), machine('machine-b')],
            recentMachinePaths: [{ machineId: 'machine-b', path: '/work/repo' }],
        })).toEqual({ machineId: 'machine-b', directory: '/work/repo' });
    });

    it('prefers a captured Session\'s machine over the Account default', () => {
        expect(resolveContextualWorkflowProjectTarget({
            machines: [machine('machine-a'), machine('machine-b')],
            recentMachinePaths: [{ machineId: 'machine-b', path: '/work/repo' }],
            preferredMachineId: 'machine-a',
        })).toEqual({ machineId: 'machine-a', directory: '~' });
    });

    it('falls back to the machine home directory when nothing recent is known', () => {
        expect(resolveContextualWorkflowProjectTarget({
            machines: [machine('machine-a')],
            recentMachinePaths: [],
        })).toEqual({ machineId: 'machine-a', directory: '~' });
    });

    it('stays unresolved rather than inventing a folder for a machine it knows nothing about', () => {
        expect(resolveContextualWorkflowProjectTarget({
            machines: [machine('machine-a', { metadata: { host: 'machine-a' } })],
            recentMachinePaths: [],
        })).toBeNull();
    });

    it('stays unresolved when there is no machine at all', () => {
        expect(resolveContextualWorkflowProjectTarget({
            machines: [],
            recentMachinePaths: [{ machineId: 'machine-gone', path: '/work/repo' }],
        })).toBeNull();
    });
});
