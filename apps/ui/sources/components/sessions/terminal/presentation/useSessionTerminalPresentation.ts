import * as React from 'react';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import type { SessionTerminalWorkspaceV1 } from '@happier-dev/protocol/terminal/workspace';

import { getAgentCore } from '@/agents/catalog/catalog';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { getStorage, useActiveMachineFacts, useMachineListForServer } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

import { resolveSessionTerminalIdentity } from '../sessionTerminalMode';
import { useTerminalSurfaceSummaries } from '../terminalSurfaceSummary';
import {
    describeSessionTerminalTabs,
    type SessionTerminalDescribeContext,
    type SessionTerminalTabDescriptor,
} from './describeSessionTerminal';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The agent is showing a dialog inside its own terminal: a pending AskUserQuestion request that
 * declares the attached-terminal notice (the same `happierDialog.mode === 'notice'` the chat card
 * reads). Agent-neutral: the dialog declaration, not an agent id, decides it.
 */
export function selectSessionAgentAsksInTerminal(session: Pick<Session, 'agentState'> | null | undefined): boolean {
    const requests = session?.agentState?.requests;
    if (!requests) return false;
    return Object.values(requests).some((request) => (
        request?.tool === 'AskUserQuestion'
        && isRecord(request.arguments)
        && isRecord(request.arguments.happierDialog)
        && request.arguments.happierDialog.mode === 'notice'
    ));
}

function selectSession(state: { sessions: Record<string, Session | undefined> }, sessionId: string, serverId: string | null): Session | null {
    const session = state.sessions[sessionId];
    if (!session) return null;
    if (serverId && !areServerProfileIdentifiersEquivalent(session.serverId, serverId)) return null;
    return session;
}

/** The session facts a terminal's description needs, each selected as a primitive. */
export function useSessionTerminalDescribeContext(sessionId: string, serverId: string | null): SessionTerminalDescribeContext {
    const useStore = getStorage();
    const agentId = useStore((state) => {
        const session = selectSession(state as never, sessionId, serverId);
        return session ? readSessionPresentationAgentId(session) : null;
    });
    const agentAsking = useStore((state) => selectSessionAgentAsksInTerminal(selectSession(state as never, sessionId, serverId)));
    const agentTerminalHost = useStore((state) => {
        const session = selectSession(state as never, sessionId, serverId);
        const mode = session ? readSessionOwnerMetadataView(session)?.terminal?.mode : undefined;
        return typeof mode === 'string' && mode !== 'plain' ? mode : null;
    });
    const machineTarget = useSessionMachineTarget(sessionId, serverId);
    const scopedMachines = useMachineListForServer(serverId ?? '');
    const activeMachines = useActiveMachineFacts();
    const machines = serverId ? scopedMachines ?? activeMachines : activeMachines;
    return React.useMemo(() => {
        const names = new Map<string, string>();
        for (const machine of machines ?? []) {
            const name = getMachineDisplayName(machine);
            if (name) names.set(machine.id, name);
        }
        const sessionMachineId = machineTarget?.machineId ?? null;
        const agentCore = agentId ? getAgentCore(agentId) : null;
        return {
            agentId,
            agentName: agentCore ? t(agentCore.displayNameKey as never) : null,
            agentAsking,
            agentTerminalHost,
            sessionMachineId,
            sessionMachineName: sessionMachineId ? names.get(sessionMachineId) ?? null : null,
            machineName: (machineId: string) => names.get(machineId) ?? null,
        };
    }, [agentAsking, agentId, agentTerminalHost, machineTarget?.machineId, machines]);
}

/**
 * Every tab of a session's terminal workspace, described from the layout (what is open) and each
 * terminal's last-known summary (what it is doing). The strip, the list view and Jump all read this,
 * so a tab says the same thing everywhere.
 */
export function useSessionTerminalTabDescriptors(input: Readonly<{
    sessionId: string;
    scopeId: string;
    workspace: SessionTerminalWorkspaceV1;
    context: SessionTerminalDescribeContext;
}>): readonly SessionTerminalTabDescriptor[] {
    const { sessionId, scopeId, workspace, context } = input;
    const terminalKeys = React.useMemo(() => workspace.tabs.flatMap((tab) => tab.terminals.map((terminal) => (
        resolveSessionTerminalIdentity({ sessionId, scopeId, terminal }).terminalKey
    ))), [scopeId, sessionId, workspace.tabs]);
    const summaries = useTerminalSurfaceSummaries(terminalKeys);
    return React.useMemo(() => describeSessionTerminalTabs(workspace.tabs, summaries, context), [context, summaries, workspace.tabs]);
}

export function useSessionTerminalScopeServerId(scopeId: string): string | null {
    return parseSessionPaneScopeId(scopeId)?.address?.serverId ?? null;
}
