import { resolveHappierDropChooserSections, type HappierDropChooserSection } from '@happier-dev/plugin-ui/presentation';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';

import { describeSessionListDropReason } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';
import { readSessionPresentationRecord, readSessionPresentationInputDisplay, readSessionPresentationInputRelations, type SessionRelationRecord } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import type { SessionManagerEligibilitySnapshot } from '@/sync/ops/relations/sessionManagerEligibility';
import { t } from '@/text';
import { sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';

import { listPutUnderCandidateOptions } from './putUnderCandidates';
import { readPutUnderCandidatePresentation, type PutUnderCandidatePresentation } from './putUnderPresentation';

export const PUT_UNDER_TOP_LEVEL_OPTION_ID = '__top_level__';

export type PutUnderChooserSection = Omit<HappierDropChooserSection, 'options'> & Readonly<{
    options: readonly (HappierDropChooserSection['options'][number] & Readonly<{ session?: PutUnderCandidatePresentation }>)[];
}>;

/**
 * The "Put under…" chooser (lab K1c): Top level, the Sessions that can lead this one, then every
 * applicable Session that cannot, under "Can't take reports" with the owner's reason — the same
 * relation facts and the same words a drag shows. Missing facts refuse; nothing pretends to be ready.
 */
export function buildPutUnderChooserSections(input: Readonly<{
    sessions: Readonly<Record<string, SessionRelationRecord>>;
    sessionId: string;
    facts: SessionManagerEligibilitySnapshot | null;
}>): readonly PutUnderChooserSection[] {
    const self = input.sessions[input.sessionId];
    if (!self) return [];
    const currentLeadId = readSessionManagerSessionIdV1(readSessionPresentationInputRelations(self));
    const candidates = listPutUnderCandidateOptions(input.sessions, { id: readSessionPresentationRecord(self).id, serverId: self.serverId }, input.facts);
    return resolveHappierDropChooserSections({
        unavailableTitle: t('entityDragDrop.chooser.cantTakeReports'),
        options: [
            { id: PUT_UNDER_TOP_LEVEL_OPTION_ID, label: t('sessionWork.putUnder.topLevel'), current: currentLeadId === null },
            ...candidates.map(({ candidate, input: source, eligibility }) => ({
                id: candidate.id,
                label: sessionDisplayTitle(readSessionPresentationInputDisplay(source), source.serverId),
                current: candidate.id === currentLeadId,
                refusedReason: eligibility.allowed ? null : describeSessionListDropReason(eligibility.reason).message,
            })),
        ],
    }).map(section => ({ ...section, options: section.options.map(option => {
        const candidate = input.sessions[option.id];
        return candidate ? { ...option, session: readPutUnderCandidatePresentation(candidate) } : option;
    }) }));
}
