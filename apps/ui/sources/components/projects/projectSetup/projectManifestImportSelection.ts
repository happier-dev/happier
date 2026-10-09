import type { ProjectDefinitionImportCandidateV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

/** Offers are facts from the canonical inspector, not a second tool/version resolver. */
export function getProjectManifestImportSelection(
    candidates: readonly ProjectDefinitionImportCandidateV1[],
    selectedIndexes?: readonly number[],
) {
    const selected = selectedIndexes === undefined ? null : new Set(selectedIndexes);
    const rows = candidates.map((candidate, index) => {
        // Ambiguity is a name collision between resolved references, not a missing tool.
        const enabled = candidate.availability === 'available' || candidate.availability === 'ambiguous';
        return {
            index,
            candidate,
            enabled,
            selected: selected ? enabled && selected.has(index) : candidate.availability === 'available' && candidate.preselected,
        };
    });
    return { rows, selected: rows.filter(row => row.selected).map(row => row.candidate) };
}
