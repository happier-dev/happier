import { describe, expect, it } from 'vitest';
import type { ProjectDefinitionImportCandidateV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { getProjectManifestImportSelection } from './projectManifestImportSelection';

const candidates: readonly ProjectDefinitionImportCandidateV1[] = [
    { source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'build' }, usage: 'script', availability: 'available', preselected: true },
    { source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'build' }, usage: 'script', availability: 'ambiguous', code: 'native_import_name_ambiguous', preselected: false },
    { source: { kind: 'native', tool: 'just', file: 'justfile', target: 'lint' }, usage: 'script', availability: 'unavailable', code: 'tool_not_found', preselected: false },
    { source: { kind: 'native', tool: 'mise', file: 'mise.toml', target: 'setup' }, usage: 'setup', availability: 'unresolved', code: 'version_unproved', preselected: false },
    { source: { kind: 'pluginNative', adapter: { pluginId: 'example.pixi', localId: 'tasks' }, file: 'pixi.toml', target: 'dev' }, usage: 'service', availability: 'available', preselected: false },
];

describe('project import selection', () => {
    it('keeps all passive offers visible and preselects only canonical available offers', () => {
        const selection = getProjectManifestImportSelection(candidates);
        expect(selection.rows.map(row => ({ index: row.index, candidate: row.candidate, enabled: row.enabled, selected: row.selected })))
            .toEqual(candidates.map((candidate, index) => ({ index, candidate, enabled: candidate.availability === 'available' || candidate.availability === 'ambiguous', selected: index === 0 })));
        expect(selection.selected).toEqual([candidates[0]]);
    });

    it('allows explicit qualified collision choices and plugin references without admitting missing or unresolved offers', () => {
        const selection = getProjectManifestImportSelection(candidates, [1, 2, 3, 4]);
        expect(selection.selected).toEqual([candidates[1], candidates[4]]);
        expect(selection.selected[1].source).toBe(candidates[4].source);
        expect(selection.rows.map(row => row.selected)).toEqual([false, true, false, false, true]);
    });
});
