import type { Session } from './storageTypes';
import type { ResumeCapabilityOptions } from '@/agents/resumeCapabilities';
import { canResumeSessionWithOptions } from '@/agents/resumeCapabilities';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog';

export function shouldRequestRemoteControlAfterPendingEnqueue(session: Session | null): boolean {
    if (!session) return false;
    return Boolean(session.agentState?.controlledByUser);
}

export type SwitchToLocalControlDisabledReason = 'machineOffline' | 'daemonStarted' | 'resumeUnsupported';

function resolveSessionLocalControlSupport(session: Session | null): { session: Session; supportsLocalControl: boolean } | null {
    if (!session) return null;
    const flavor = (session.metadata as any)?.flavor;
    const agentId = resolveAgentIdFromFlavor(typeof flavor === 'string' ? flavor : null);
    if (!agentId) return null;
    return {
        session,
        supportsLocalControl: getAgentCore(agentId).localControl?.supported === true,
    };
}

export function getSwitchToLocalControlDisabledReason(opts: {
    session: Session | null;
    isMachineOnline: boolean;
    resumeCapabilityOptions: ResumeCapabilityOptions;
}): SwitchToLocalControlDisabledReason | null {
    const resolved = resolveSessionLocalControlSupport(opts.session);
    if (!resolved || !resolved.supportsLocalControl) return null;
    const session = resolved.session;
    if (session.agentState?.controlledByUser === true) return null;

    // Fail closed for daemon-started sessions (no interactive TUI).
    const startedFromDaemon = Boolean((session.metadata as any)?.startedFromDaemon);
    if (startedFromDaemon) return 'daemonStarted';

    if (!opts.isMachineOnline) return 'machineOffline';

    if (!canResumeSessionWithOptions(session.metadata as any, opts.resumeCapabilityOptions)) {
        return 'resumeUnsupported';
    }

    return null;
}

export function shouldOfferSwitchToLocalControl(opts: {
    session: Session | null;
    isMachineOnline: boolean;
    resumeCapabilityOptions: ResumeCapabilityOptions;
}): boolean {
    const resolved = resolveSessionLocalControlSupport(opts.session);
    if (!resolved || !resolved.supportsLocalControl) return false;
    if (resolved.session.agentState?.controlledByUser === true) return false;
    return getSwitchToLocalControlDisabledReason(opts) == null;
}

export function shouldRenderChatTimelineForSession(opts: {
    committedMessagesCount: number;
    pendingMessagesCount: number;
    controlledByUser: boolean;
    forceRenderFooter?: boolean;
}): boolean {
    return opts.committedMessagesCount > 0
        || opts.pendingMessagesCount > 0
        || opts.controlledByUser === true
        || opts.forceRenderFooter === true;
}
