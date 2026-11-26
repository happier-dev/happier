import { resolveHappierDropChooserSections, type HappierDropChooserSection } from '@happier-dev/plugin-ui/presentation';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';

import { describeSessionListDropReason } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';
import { readSessionBotFaceFacts, type SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { readSessionPresentationRecord, readSessionPresentationInputDisplay, readSessionPresentationInputRelations,
    readSessionPresentationInputSource, type SessionRelationRecord } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import type { SessionManagerEligibilitySnapshot } from '@/sync/ops/relations/sessionManagerEligibility';
import { t } from '@/text';
import { sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';

import { listPutUnderCandidateOptions } from './putUnderCandidates';
import { readPutUnderCandidatePresentation, type PutUnderCandidatePresentation } from './putUnderPresentation';

export const PUT_UNDER_TOP_LEVEL_OPTION_ID = '__top_level__';

export type PutUnderChooserSection = Omit<HappierDropChooserSection, 'options'> & Readonly<{
    options: readonly (HappierDropChooserSection['options'][number] & Readonly<{
        session?: PutUnderCandidatePresentation;
        botFace?: SessionBotFaceFacts;
    }>)[];
}>;

/**
 * The "Report to…" chooser (lab K1c): Top level, the Sessions that can lead this one, then every
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
    const candidates = listPutUnderCandidateOptions(input.sessions, { id: readSessionPresentationRecord(self).id, serverId: self.serverId }, input.facts)
        .map(({ candidate, input: source, eligibility }) => {
            const display = readSessionPresentationInputDisplay(source);
            const session = readPutUnderCandidatePresentation(source);
            const botFace = readSessionBotFaceFacts(display, source.serverId ?? null, readSessionPresentationInputSource(source));
            const current = candidate.id === currentLeadId;
            const hasReports = (session.leadsCount ?? 0) > 0;
            const rank = botFace ? 0 : current || hasReports ? 1 : 2;
            const priorLeadPriority = hasReports || session.roleId === 'orchestrator' ? 0 : 1;
            return {
                id: candidate.id,
                label: sessionDisplayTitle(display, source.serverId),
                current,
                refusedReason: eligibility.allowed ? null : describeSessionListDropReason(eligibility.reason).message,
                session, botFace, rank, priorLeadPriority,
            };
        });
    const presentationById = new Map(candidates.map(candidate => [candidate.id, candidate]));
    const groupTitles = [t('settingsFeatures.bots'), t('sessionWork.putUnder.leadSessions'), t('sessionWork.putUnder.otherSessions')];
    // Keep the previous lead priority and recency within each eligible group.
    const available = candidates.filter(candidate => candidate.refusedReason === null)
        .sort((a, b) => a.rank - b.rank || a.priorLeadPriority - b.priorLeadPriority);
    return resolveHappierDropChooserSections({
        unavailableTitle: t('entityDragDrop.chooser.cantTakeReports'),
        options: [
            { id: PUT_UNDER_TOP_LEVEL_OPTION_ID, label: t('sessionWork.putUnder.topLevel'), current: currentLeadId === null },
            ...available.map(candidate => ({ ...candidate, group: groupTitles[candidate.rank] })),
            ...candidates.filter(candidate => candidate.refusedReason !== null),
        ],
    }).map(section => ({ ...section, options: section.options.map(option => {
        const candidate = presentationById.get(option.id);
        return candidate ? { ...option, session: candidate.session, ...(candidate.botFace ? { botFace: candidate.botFace } : {}) } : option;
    }) }));
}
