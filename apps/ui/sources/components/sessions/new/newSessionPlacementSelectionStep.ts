import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import type { SelectionListSectionDescriptor, SelectionListStep } from '@/components/ui/selectionList';
import { t } from '@/text';
import type { SessionPlacementCandidateRow } from './serverStartDraftCandidateSelection';

type PlacementSelectionParams = Readonly<{
    rows: readonly SessionPlacementCandidateRow[];
    onSelect: (candidate: PluginUiSessionPlacementCandidateV1) => void;
}>;

/** The saved-project choices, as one section: the picker below and the folder chip's picker both list them. */
export function createNewSessionPlacementCandidatesSection(
    params: PlacementSelectionParams & Readonly<{ title?: string }>,
): SelectionListSectionDescriptor {
    return {
        kind: 'static',
        id: 'new-session-seeded-placement-candidates',
        ...(params.title ? { title: params.title } : {}),
        options: params.rows.map((row) => ({
            id: `new-session-seeded-placement:${row.index}`,
            label: row.title,
            ...(row.subtitle ? { subtitle: row.subtitle } : {}),
            // Machine and folder both tell projects apart: line 2 wraps instead of cutting either off.
            subtitleLines: 2,
            onSelect: () => params.onSelect(row.candidate),
        })),
    };
}

/** The saved-project choices used by preparation before authoring. */
export function createNewSessionPlacementSelectionStep(params: PlacementSelectionParams): SelectionListStep {
    return {
        id: 'new-session-seeded-placement-root',
        title: t('newSession.selectWorkingDirectoryTitle'),
        sections: [createNewSessionPlacementCandidatesSection(params)],
    };
}
