import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { buildRequesterDisclosureStatusBadge } from '@/components/machines/managed/managedComposerBadges';
import type { RequesterDisclosureModel } from '@/components/machines/managed/RequesterDisclosure';
import type { AgentSessionStartBlockLine } from '@/components/machines/agents/agentSessionStartBlockLine';
import type { NewSessionLaunchPresentation } from '../../modules/newSessionLaunchPresentation';

type NewSessionLaunchStatusParams = Readonly<{
    isCreating: boolean;
    /** The canonical launch presentation already carries progress when active. */
    launchPresentation?: NewSessionLaunchPresentation;
    disabledReason?: string | null;
    /** The chosen agent cannot start on the chosen machine: that cause leads the line, with its own actions. */
    agentStartBlock?: AgentSessionStartBlockLine | null;
    requesterDisclosure?: RequesterDisclosureModel;
    translate: (key: 'newSession.startingSession') => string;
}>;

/**
 * The launch's one cause, said on the composer's status line above the card (left), the same line a
 * session uses for its status (0.2 anatomy). `blocked` needs the person; `starting` needs nothing.
 */
export type NewSessionLaunchStatusLine = Readonly<{
    kind: 'blocked' | 'starting';
    text: string;
    detail?: string;
    action?: AgentSessionStartBlockLine['action'];
    secondaryAction?: AgentSessionStartBlockLine['secondaryAction'];
}>;

export type NewSessionLaunchStatus = Readonly<{
    line: NewSessionLaunchStatusLine | null;
    /** Right-aligned badges keep only facts with their own detail (the requester disclosure). */
    badges: ReadonlyArray<AgentInputStatusBadge>;
}>;

export function buildNewSessionLaunchStatus(params: NewSessionLaunchStatusParams): NewSessionLaunchStatus {
    const badges: ReadonlyArray<AgentInputStatusBadge> = params.requesterDisclosure
        ? [buildRequesterDisclosureStatusBadge(params.requesterDisclosure)] : [];
    if (params.isCreating) {
        return { line: params.launchPresentation && params.launchPresentation !== 'none'
            ? null : { kind: 'starting', text: params.translate('newSession.startingSession') }, badges };
    }
    // One cause, one line: the agent's own start block (with its actions) says why the launch is disabled.
    if (params.agentStartBlock) return { line: { kind: 'blocked', ...params.agentStartBlock }, badges };
    return { line: params.disabledReason ? { kind: 'blocked', text: params.disabledReason } : null, badges };
}
