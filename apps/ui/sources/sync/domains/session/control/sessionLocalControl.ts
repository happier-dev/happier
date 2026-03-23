import type { Session, AgentState } from '@/sync/domains/state/storageTypes';

export type SessionLocalControlTopology = 'exclusive' | 'shared';

export type SessionLocalControlState = Readonly<{
    attached: boolean;
    topology: SessionLocalControlTopology;
    remoteWritable: boolean;
    canAttach: boolean;
    canDetach: boolean;
}>;

function normalizeBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function readAgentStateLocalControl(agentState: AgentState | null | undefined): SessionLocalControlState | null {
    if (!agentState || typeof agentState !== 'object') return null;
    const raw = agentState.localControl;
    if (!raw || typeof raw !== 'object') return null;

    const attached = normalizeBoolean(raw.attached) === true;
    const topology = raw.topology === 'shared' ? 'shared' : 'exclusive';
    const remoteWritable = normalizeBoolean(raw.remoteWritable) ?? (!attached || topology === 'shared');
    const canAttach = normalizeBoolean(raw.canAttach) ?? (!attached);
    const canDetach = normalizeBoolean(raw.canDetach) ?? attached;

    return {
        attached,
        topology,
        remoteWritable,
        canAttach,
        canDetach,
    };
}

export function getSessionLocalControlState(session: Session | null): SessionLocalControlState | null {
    const state = readAgentStateLocalControl(session?.agentState ?? null);
    if (state) return state;

    if (session?.agentState?.controlledByUser === true) {
        return {
            attached: true,
            topology: 'exclusive',
            remoteWritable: false,
            canAttach: false,
            canDetach: true,
        };
    }

    return null;
}

export function isSessionLocallyAttached(session: Session | null): boolean {
    return getSessionLocalControlState(session)?.attached === true;
}

export function isSessionExclusiveLocalControl(session: Session | null): boolean {
    const state = getSessionLocalControlState(session);
    return state?.attached === true && state.topology === 'exclusive';
}

export function isSessionRemoteWritableWhileLocallyAttached(session: Session | null): boolean {
    const state = getSessionLocalControlState(session);
    return state?.attached === true && state.remoteWritable === true;
}
