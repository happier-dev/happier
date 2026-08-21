import { Modal } from '@/modal';
import { t } from '@/text';

import {
    AGENT_TRANSITION_HANDED_OVER_MODAL_TEST_ID,
    AgentTransitionHandedOverContextModal,
} from './AgentTransitionHandedOverContextModal';

export type OpenAgentTransitionHandedOverContextModalParams = Readonly<{
    sessionId: string;
    machineId: string | null;
    serverId: string | null;
    /** The transcript cutoff the divider recorded. `0` means nothing was carried over. */
    sourceCutoffSeqInclusive: number;
    /** The divider's native-return bound, or `null` for a fresh target. */
    returningAgentLastSeenSeqInclusive: number | null;
    /** The boundary's two Agents, exactly as the divider records them. */
    sourceAgentId: string;
    targetAgentId: string;
    /** Names both Agents, so the card says which boundary it is explaining. */
    boundaryTitle: string;
    onJumpToCutoff: (() => void) | null;
}>;

/**
 * The one launcher for the handed-over context card.
 *
 * The backdrop DOES close it, unlike the fork strategy modal: this card owns no
 * effect and no pending operation, so a stray tap costs the reader nothing but
 * the scroll position of a read-only page.
 */
export function openAgentTransitionHandedOverContextModal(
    params: OpenAgentTransitionHandedOverContextModalParams,
): string {
    return Modal.show({
        component: AgentTransitionHandedOverContextModal,
        props: {
            sessionId: params.sessionId,
            machineId: params.machineId,
            serverId: params.serverId,
            sourceCutoffSeqInclusive: params.sourceCutoffSeqInclusive,
            returningAgentLastSeenSeqInclusive: params.returningAgentLastSeenSeqInclusive,
            sourceAgentId: params.sourceAgentId,
            targetAgentId: params.targetAgentId,
            onJumpToCutoff: params.onJumpToCutoff,
        },
        chrome: {
            kind: 'card',
            title: t('session.agentContinuation.handedOver.title'),
            // The boundary this card explains, in the divider's own words, so
            // the reader never has to hold "which switch was that?" in mind.
            subtitle: params.boundaryTitle,
            testID: `${AGENT_TRANSITION_HANDED_OVER_MODAL_TEST_ID}-card`,
            bodyScroll: 'auto',
            dimensions: { size: 'md', width: 560, maxHeightRatio: 0.86 },
        },
    });
}
