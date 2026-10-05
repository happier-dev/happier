import { resolveHappierDropChooserSections, type HappierDropChooserSection } from '@happier-dev/plugin-ui/presentation';

import { describeSessionListDropReason } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionReportsToEligibilitySnapshot } from '@/sync/ops/relations/sessionReportsToEligibility';
import { t } from '@/text';

import { listPutUnderCandidateOptions } from './putUnderCandidates';

export const PUT_UNDER_TOP_LEVEL_OPTION_ID = '__top_level__';

/**
 * The "Put under…" chooser (lab K1c): Top level, the Sessions that can lead this one, then every
 * applicable Session that cannot, under "Can't take reports" with the owner's reason — the same
 * relation facts and the same words a drag shows. Missing facts refuse; nothing pretends to be ready.
 */
export function buildPutUnderChooserSections(input: Readonly<{
    sessions: Readonly<Record<string, Session>>;
    sessionId: string;
    facts: SessionReportsToEligibilitySnapshot | null;
    describeName: (session: Session) => string;
}>): readonly HappierDropChooserSection[] {
    const self = input.sessions[input.sessionId];
    if (!self) return [];
    const currentLeadId = self.reportsTo?.sessionId ?? null;
    const candidates = listPutUnderCandidateOptions(input.sessions, self, input.facts);
    return resolveHappierDropChooserSections({
        unavailableTitle: t('entityDragDrop.chooser.cantTakeReports'),
        options: [
            { id: PUT_UNDER_TOP_LEVEL_OPTION_ID, label: t('sessionWork.putUnder.topLevel'), current: currentLeadId === null },
            ...candidates.map(({ candidate, eligibility }) => ({
                id: candidate.id,
                label: input.describeName(candidate),
                current: candidate.id === currentLeadId,
                refusedReason: eligibility.allowed ? null : describeSessionListDropReason(eligibility.reason).message,
            })),
        ],
    });
}
