import type { Session } from '@/sync/domains/state/storageTypes';
import type { AgentState } from '@happier-dev/session-core/state';
import { isSessionTerminalPermanentlyAbsent, readSessionTerminalControlServiceabilityStateV1 } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

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
    const remoteWritable = normalizeBoolean(raw.remoteWritable) === true;
    const canAttach = normalizeBoolean(raw.canAttach) ?? (!attached);
    // Shared release needs explicit runner custody; legacy exclusive control
    // keeps its released attached-state fallback.
    const canDetach = normalizeBoolean(raw.canDetach) ?? (topology === 'exclusive' && attached);

    return {
        attached,
        topology,
        remoteWritable,
        canAttach,
        canDetach,
    };
}

export function getSessionLocalControlState(session: Session | null): SessionLocalControlState | null {
    // Agent state survives shutdown. Live controls require the current runner;
    // preserved terminal-host recovery remains owned by terminal serviceability.
    if (session?.active !== true) return null;
    const serviceability = readSessionOwnerMetadataView(session)?.terminal?.controlServiceabilityV1;
    if (isSessionTerminalPermanentlyAbsent(serviceability)
        || readSessionTerminalControlServiceabilityStateV1(serviceability) === 'recoverable_unservable') return null;

    const state = readAgentStateLocalControl(session.agentState);
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
