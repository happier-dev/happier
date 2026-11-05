import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { t } from '@/text';
import type { SessionPlacementCandidateRow } from './serverStartDraftCandidateSelection';

/** The saved-project choices used by New Session and preparation before authoring. */
export function createNewSessionPlacementSelectionStep(params: Readonly<{
    rows: readonly SessionPlacementCandidateRow[];
    onSelect: (candidate: PluginUiSessionPlacementCandidateV1) => void;
}>): SelectionListStep {
    return {
        id: 'new-session-seeded-placement-root',
        title: t('newSession.selectWorkingDirectoryTitle'),
        sections: [{
            kind: 'static',
            id: 'new-session-seeded-placement-candidates',
            options: params.rows.map((row) => ({
                id: `new-session-seeded-placement:${row.index}`,
                label: row.title,
                ...(row.subtitle ? { subtitle: row.subtitle } : {}),
                // Machine and folder both tell projects apart: line 2 wraps instead of cutting either off.
                subtitleLines: 2,
                onSelect: () => params.onSelect(row.candidate),
            })),
        }],
    };
}
