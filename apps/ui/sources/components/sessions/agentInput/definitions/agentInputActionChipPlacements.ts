import { t } from '@/text';
import type { AgentInputControlPlacement } from '../controls/agentInputControlTypes';

export const SESSION_SOURCE_CONTEXT_CHIP_KEY = 'session-source-context';

export function getLinkedFilesActionChipPlacement(): AgentInputControlPlacement {
    return { id: 'linkedFiles', title: t('navigationPlacement.linkedFiles'), icon: 'at', defaultPlacement: 'overflow', menu: { disclosure: false } };
}

export function getMentionActionChipPlacement(): AgentInputControlPlacement {
    return { id: 'shortcuts:mention', title: t('session.collaboration.discussion.composer.mention'), icon: 'at', defaultPlacement: 'overflow' };
}

export function getSessionSourceContextActionChipPlacement(): AgentInputControlPlacement {
    return { id: `shortcuts:${SESSION_SOURCE_CONTEXT_CHIP_KEY}`, title: t('session.sourceContext.detailTitle'), icon: 'git-branch', defaultPlacement: 'overflow' };
}

export function getTemporaryComputerTeamAccessActionChipPlacement(): AgentInputControlPlacement {
    return { id: 'sessionAccess:new-session-temporary-computer-team-access', title: t('newSession.temporaryComputer.teamAccess.title'), icon: 'shield-check', defaultPlacement: 'overflow' };
}

export function getConnectedServicesAuthActionChipPlacement(params: Readonly<{ scoped?: boolean }> = {}): AgentInputControlPlacement {
    // Its default placement is the registry's (`agentInputControlRegistry`), decided once there.
    return { id: params.scoped ? 'connectedServices:new-session-connected-services-auth' : 'connectedServices', title: t('connectedServices.authChip.popoverTitle'), icon: 'path' };
}

export function getReviewCommentsActionChipPlacement(): AgentInputControlPlacement {
    return { id: 'reviewComments:review-comments', title: t('files.reviewComments.durable.headerTitle'), icon: 'chat-dots', defaultPlacement: 'overflow' };
}

export function getBrowserContextActionChipPlacement(): AgentInputControlPlacement {
    return { id: 'shortcuts:browser-context', title: t('actionFamilies.browser_context'), icon: 'globe', defaultPlacement: 'overflow' };
}

export type AgentInputRecipientPlacementContext = 'session' | 'discussion';

export function getRecipientActionChipPlacement(context: AgentInputRecipientPlacementContext = 'session'): AgentInputControlPlacement {
    return { id: 'recipient', title: t('session.participants.sendToTitle'), icon: 'navigation-arrow', defaultPlacement: context === 'discussion' ? 'pinned' : 'overflow' };
}

export function getAgentInputResetStartPlacement(): AgentInputControlPlacement {
    return { id: 'delivery:resetStart', title: t('usage.board.plans.sendAtReset'), icon: 'clock', pending: false,
        menu: { description: t('usage.board.plans.resetStartMeta'), disclosure: true } };
}

export function getExecutionRunRequestedActionChipPlacement(): AgentInputControlPlacement {
    return { id: 'delivery:execution-run-requested-action', title: t('runs.delivery.title'), icon: 'sliders-horizontal', defaultPlacement: 'overflow' };
}

