import { describe, expect, it } from 'vitest';
import {
    WorkspaceSyncConflictInspectRpcResultV1Schema,
    type WorkspaceSyncConflictPageV1,
} from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { buildReviewedWorkspaceSyncResolution, isReviewedWorkspaceSyncResolutionCurrent, projectLoadedWorkspaceSyncConflicts, resolveWorkspaceSyncComparisonText } from './workspaceSyncConflictReviewModel';

const a = { kind: 'file' as const, digest: 'a'.repeat(40), executable: true, size: 12 };
const b = { kind: 'file' as const, digest: 'b'.repeat(40), executable: false, size: 12 };
const c = { kind: 'symlink' as const, target: '../shared' };

describe('workspace sync conflict review model', () => {
    it('shows a text-versus-missing change without inventing text for unreadable files', () => {
        const text = { status: 'text' as const, text: 'hello\n' };
        expect(resolveWorkspaceSyncComparisonText({ left: a, right: { kind: 'missing' }, leftPreview: text, rightPreview: null }))
            .toEqual({ oldText: 'hello\n', newText: '' });
        expect(resolveWorkspaceSyncComparisonText({ left: { kind: 'missing' }, right: a, leftPreview: null, rightPreview: text }))
            .toEqual({ oldText: '', newText: 'hello\n' });
        expect(resolveWorkspaceSyncComparisonText({ left: a, right: b, leftPreview: { status: 'binary' }, rightPreview: text })).toBeNull();
        expect(resolveWorkspaceSyncComparisonText({ left: c, right: a, leftPreview: null, rightPreview: text })).toBeNull();
    });
    it('groups a C-opened set path from both loaded link pages without summing pairwise totals', () => {
        const page = (relationshipId: string, paths: string[]): WorkspaceSyncConflictPageV1 => ({
            status: 'page', relationshipId, totalCount: paths.length, nextCursor: null,
            conflicts: paths.map((path) => ({ relationshipId, path, alpha: { kind: 'file', digest: 'a'.repeat(40) }, beta: { kind: 'file', digest: 'b'.repeat(40) } })),
        });
        const review = projectLoadedWorkspaceSyncConflicts({
            relationships: [
                { relationshipId: 'a-b', controllerMachineId: 'machine-a' },
                { relationshipId: 'a-c', controllerMachineId: 'machine-a' },
            ],
            pages: [
                { relationshipId: 'a-b', page: page('a-b', ['same.txt', 'only-b.txt']) },
                { relationshipId: 'a-c', page: page('a-c', ['same.txt']) },
            ],
        });
        expect(review.rows.map((row) => row.path)).toEqual(['only-b.txt', 'same.txt']);
        expect(review.rows.find((row) => row.path === 'same.txt')?.entries).toHaveLength(2);
        expect(review.coverage).toMatchObject({ complete: true, shownPathCount: 2 });
    });

    it('reviews one observed source and every distinct destination expectation, including executable and symlink semantics', () => {
        const inspection = WorkspaceSyncConflictInspectRpcResultV1Schema.parse({
            controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/tool',
            endpoints: [
                { workspaceRefId: 'workspace-a', outcome: 'observed', observation: a, selections: [] },
                { workspaceRefId: 'workspace-b', outcome: 'observed', observation: b, selections: [] },
                { workspaceRefId: 'workspace-c', outcome: 'observed', observation: c, selections: [] },
            ],
            versions: [
                { endpointWorkspaceRefIds: ['workspace-a'], entry: a },
                { endpointWorkspaceRefIds: ['workspace-b'], entry: b },
                { endpointWorkspaceRefIds: ['workspace-c'], entry: c },
            ], coverage: { complete: true },
        });
        expect(buildReviewedWorkspaceSyncResolution({
            inspection, sourceWorkspaceRefId: 'workspace-c', selectedTargetWorkspaceRefIds: ['workspace-a', 'workspace-b'], relationshipIds: ['a-b', 'a-c'],
        })).toEqual({
            strategy: 'use_source', controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/tool',
            source: { workspaceRefId: 'workspace-c', expected: c },
            targets: [
                { workspaceRefId: 'workspace-a', expected: a },
                { workspaceRefId: 'workspace-b', expected: b },
            ], relationshipIds: ['a-b', 'a-c'],
        });
    });

    it('does not authorize resolution without an observed destination', () => {
        const inspection = WorkspaceSyncConflictInspectRpcResultV1Schema.parse({
            controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/tool',
            endpoints: [
                { workspaceRefId: 'workspace-a', outcome: 'observed', observation: a, selections: [] },
                { workspaceRefId: 'workspace-b', outcome: 'unreachable', selections: [] },
            ],
            versions: [{ endpointWorkspaceRefIds: ['workspace-a'], entry: a }], coverage: { complete: false },
        });
        expect(buildReviewedWorkspaceSyncResolution({
            inspection, sourceWorkspaceRefId: 'workspace-a', selectedTargetWorkspaceRefIds: ['workspace-b'], relationshipIds: ['a-b'],
        })).toBeNull();
    });

    it('can review only the observed destinations while an unrelated endpoint is offline', () => {
        const inspection = WorkspaceSyncConflictInspectRpcResultV1Schema.parse({
            controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/tool',
            endpoints: [
                { workspaceRefId: 'workspace-a', outcome: 'observed', observation: a, selections: [] },
                { workspaceRefId: 'workspace-b', outcome: 'observed', observation: b, selections: [] },
                { workspaceRefId: 'workspace-c', outcome: 'unreachable', selections: [] },
            ],
            versions: [
                { endpointWorkspaceRefIds: ['workspace-a'], entry: a },
                { endpointWorkspaceRefIds: ['workspace-b'], entry: b },
            ],
            coverage: { complete: false },
        });
        expect(buildReviewedWorkspaceSyncResolution({
            inspection, sourceWorkspaceRefId: 'workspace-a', selectedTargetWorkspaceRefIds: ['workspace-b'], relationshipIds: ['a-b', 'a-c'],
        })).toEqual({
            strategy: 'use_source', controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/tool',
            source: { workspaceRefId: 'workspace-a', expected: a },
            targets: [{ workspaceRefId: 'workspace-b', expected: b }],
            relationshipIds: ['a-b', 'a-c'],
        });
    });

    it('binds Keep both to the controller-observed surviving alternative and rejects unavailable alternatives', () => {
        const inspected = WorkspaceSyncConflictInspectRpcResultV1Schema.parse({
            controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/tool',
            endpoints: [
                { workspaceRefId: 'workspace-a', outcome: 'observed', observation: a, selections: [] },
                { workspaceRefId: 'workspace-b', outcome: 'observed', observation: b, selections: [] },
                { workspaceRefId: 'workspace-c', outcome: 'unreachable', selections: [] },
            ],
            versions: [
                { endpointWorkspaceRefIds: ['workspace-a'], entry: a },
                { endpointWorkspaceRefIds: ['workspace-b'], entry: b },
            ],
            preservationOptions: [{
                status: 'available', source: { workspaceRefId: 'workspace-b', expected: b },
                destination: { workspaceRefId: 'workspace-a', path: 'src/tool.happier-conflict.b', expected: { kind: 'missing' } },
                consequence: { propagatingToWorkspaceRefIds: ['workspace-b'], unverifiedPropagationToWorkspaceRefIds: ['workspace-c'] },
            }],
            coverage: { complete: false },
        });
        expect(buildReviewedWorkspaceSyncResolution({
            inspection: inspected, sourceWorkspaceRefId: 'workspace-a', selectedTargetWorkspaceRefIds: ['workspace-b'], relationshipIds: ['a-b', 'a-c'], strategy: 'keep_both',
        })).toEqual({
            strategy: 'keep_both', controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/tool',
            source: { workspaceRefId: 'workspace-a', expected: a },
            targets: [{ workspaceRefId: 'workspace-b', expected: b }], relationshipIds: ['a-b', 'a-c'],
            alternatives: [{
                source: { workspaceRefId: 'workspace-b', expected: b },
                destination: { workspaceRefId: 'workspace-a', path: 'src/tool.happier-conflict.b', expected: { kind: 'missing' } },
                consequence: { propagatingToWorkspaceRefIds: ['workspace-b'], unverifiedPropagationToWorkspaceRefIds: ['workspace-c'] },
            }],
        });
        expect(buildReviewedWorkspaceSyncResolution({
            inspection: { ...inspected, preservationOptions: [{
                status: 'unavailable', source: { workspaceRefId: 'workspace-b', expected: b }, reason: 'selection_unavailable',
            }] },
            sourceWorkspaceRefId: 'workspace-a', selectedTargetWorkspaceRefIds: ['workspace-b'], relationshipIds: ['a-b', 'a-c'], strategy: 'keep_both',
        })).toBeNull();
        const reviewed = buildReviewedWorkspaceSyncResolution({
            inspection: inspected, sourceWorkspaceRefId: 'workspace-a', selectedTargetWorkspaceRefIds: ['workspace-b'], relationshipIds: ['a-b', 'a-c'], strategy: 'keep_both',
        });
        expect(reviewed && isReviewedWorkspaceSyncResolutionCurrent(inspected, reviewed)).toBe(true);
        expect(reviewed && isReviewedWorkspaceSyncResolutionCurrent({ ...inspected, preservationOptions: [{
            status: 'available', source: { workspaceRefId: 'workspace-b', expected: b },
            destination: { workspaceRefId: 'workspace-a', path: 'src/tool.happier-conflict.b', expected: { kind: 'missing' } },
            consequence: { propagatingToWorkspaceRefIds: ['workspace-b'], unverifiedPropagationToWorkspaceRefIds: [] },
        }] }, reviewed)).toBe(true);
        expect(reviewed && isReviewedWorkspaceSyncResolutionCurrent({ ...inspected, preservationOptions: [{
            status: 'available', source: { workspaceRefId: 'workspace-b', expected: b },
            destination: { workspaceRefId: 'workspace-a', path: 'src/tool.happier-conflict.b', expected: { kind: 'missing' } },
            consequence: { propagatingToWorkspaceRefIds: [], unverifiedPropagationToWorkspaceRefIds: ['workspace-b', 'workspace-c'] },
        }] }, reviewed)).toBe(true);
        expect(reviewed && isReviewedWorkspaceSyncResolutionCurrent({ ...inspected, preservationOptions: [{
            status: 'available', source: { workspaceRefId: 'workspace-b', expected: b },
            destination: { workspaceRefId: 'workspace-a', path: 'src/tool.happier-conflict.b', expected: { kind: 'missing' } },
            consequence: { propagatingToWorkspaceRefIds: [], unverifiedPropagationToWorkspaceRefIds: ['workspace-c'] },
        }] }, reviewed)).toBe(false);
        expect(reviewed && isReviewedWorkspaceSyncResolutionCurrent({ ...inspected, preservationOptions: [{
            status: 'available', source: { workspaceRefId: 'workspace-b', expected: b },
            destination: { workspaceRefId: 'workspace-a', path: 'src/tool.happier-conflict.changed', expected: { kind: 'missing' } },
            consequence: { propagatingToWorkspaceRefIds: ['workspace-b'] },
        }] }, reviewed)).toBe(false);
    });

    it('binds only explicitly chosen destinations and ignores drift of an untouched version', () => {
        const d = { kind: 'file' as const, digest: 'd'.repeat(40), executable: false, size: 15 };
        const inspection = WorkspaceSyncConflictInspectRpcResultV1Schema.parse({
            controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/tool',
            endpoints: [
                { workspaceRefId: 'workspace-a', outcome: 'observed', observation: a, selections: [] },
                { workspaceRefId: 'workspace-b', outcome: 'observed', observation: b, selections: [] },
                { workspaceRefId: 'workspace-c', outcome: 'observed', observation: d, selections: [] },
            ],
            versions: [
                { endpointWorkspaceRefIds: ['workspace-a'], entry: a },
                { endpointWorkspaceRefIds: ['workspace-b'], entry: b },
                { endpointWorkspaceRefIds: ['workspace-c'], entry: d },
            ], coverage: { complete: true },
        });
        const selected = buildReviewedWorkspaceSyncResolution({ inspection,
            sourceWorkspaceRefId: 'workspace-a', selectedTargetWorkspaceRefIds: ['workspace-b'], relationshipIds: ['a-b', 'a-c'] });
        expect(selected?.targets).toEqual([{ workspaceRefId: 'workspace-b', expected: b }]);
        expect(selected && isReviewedWorkspaceSyncResolutionCurrent({ ...inspection,
            endpoints: inspection.endpoints.map((endpoint) => endpoint.workspaceRefId === 'workspace-c'
                ? { ...endpoint, observation: c } : endpoint),
            versions: [...inspection.versions.slice(0, 2), { endpointWorkspaceRefIds: ['workspace-c'], entry: c }],
        }, selected)).toBe(true);
        expect(selected && isReviewedWorkspaceSyncResolutionCurrent({ ...inspection,
            endpoints: inspection.endpoints.map((endpoint) => endpoint.workspaceRefId === 'workspace-b'
                ? { ...endpoint, observation: d } : endpoint),
            versions: [inspection.versions[0]!, { endpointWorkspaceRefIds: ['workspace-b'], entry: d }, inspection.versions[2]!],
        }, selected)).toBe(false);
    });

    it('preserves only file versions displaced by the chosen targets', () => {
        const d = { kind: 'file' as const, digest: 'd'.repeat(40), executable: false, size: 15 };
        const inspected = WorkspaceSyncConflictInspectRpcResultV1Schema.parse({
            controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'src/tool',
            endpoints: [
                { workspaceRefId: 'workspace-a', outcome: 'observed', observation: a, selections: [] },
                { workspaceRefId: 'workspace-b', outcome: 'observed', observation: b, selections: [] },
                { workspaceRefId: 'workspace-c', outcome: 'observed', observation: d, selections: [] },
            ],
            versions: [
                { endpointWorkspaceRefIds: ['workspace-a'], entry: a },
                { endpointWorkspaceRefIds: ['workspace-b'], entry: b },
                { endpointWorkspaceRefIds: ['workspace-c'], entry: d },
            ],
            preservationOptions: [b, d].map((entry, index) => ({
                status: 'available' as const,
                source: { workspaceRefId: index === 0 ? 'workspace-b' : 'workspace-c', expected: entry },
                destination: { workspaceRefId: 'workspace-a', path: `src/tool.happier-conflict.${index}`, expected: { kind: 'missing' as const } },
                consequence: { propagatingToWorkspaceRefIds: [] },
            })),
            coverage: { complete: true },
        });
        const request = buildReviewedWorkspaceSyncResolution({ inspection: inspected,
            sourceWorkspaceRefId: 'workspace-a', selectedTargetWorkspaceRefIds: ['workspace-b'],
            relationshipIds: ['a-b', 'a-c'], strategy: 'keep_both' });
        expect(request?.targets.map((target) => target.workspaceRefId)).toEqual(['workspace-b']);
        expect(request?.strategy === 'keep_both' ? request.alternatives.map((alternative) => alternative.source.workspaceRefId) : null)
            .toEqual(['workspace-b']);
    });

});
