import type { SessionTerminalMemberV1, SessionTerminalTabV1 } from '@happier-dev/protocol/terminal/workspace';

import { t } from '@/text';
import type { TerminalSurfaceSummary } from '../terminalSurfaceSummary';
import { isTerminalTargetReadOnly } from '../terminalAttachment';

/** What the strip, the list view and Jump say about one terminal (terminal lab B1/B3/B4, A1). */
export type SessionTerminalStatus = 'running' | 'attention' | 'connection-lost' | 'exited' | 'failed';

export type SessionTerminalMark =
    | Readonly<{ kind: 'shell' }>
    | Readonly<{ kind: 'agent'; agentId: string }>
    | Readonly<{ kind: 'machine' }>;

export type SessionTerminalDescriptor = Readonly<{
    terminalId: string;
    title: string;
    mark: SessionTerminalMark;
    status: SessionTerminalStatus | null;
    /** The list/Jump second line: what it is doing, or where it runs. */
    detail: string | null;
    /** Where it runs, said only when that differs from the session's own folder and machine. */
    place: string | null;
    /** The address it printed, for the live pill. */
    url: string | null;
    /** A borrowed view of another session's terminal: closing it never stops the process. */
    borrowed: boolean;
}>;

export type SessionTerminalTabDescriptor = Readonly<{
    tabId: string;
    title: string;
    mark: SessionTerminalMark;
    status: SessionTerminalStatus | null;
    members: readonly SessionTerminalDescriptor[];
}>;

/** Facts about the session the terminals belong to. Plain values, so describing stays pure. */
export type SessionTerminalDescribeContext = Readonly<{
    agentId: string | null;
    agentName: string | null;
    /** The agent shows a dialog in its own terminal (an attached-terminal notice is pending). */
    agentAsking: boolean;
    /** tmux, zellij or herdr: the host the agent's terminal runs in. */
    agentTerminalHost: string | null;
    sessionMachineId: string | null;
    sessionMachineName: string | null;
    machineName: (machineId: string) => string | null;
}>;

const STATUS_RANK: Readonly<Record<SessionTerminalStatus, number>> = {
    attention: 5, failed: 4, 'connection-lost': 3, running: 2, exited: 1,
};

function basename(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, '');
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed;
}

/** A printed address as people say it: `localhost:5173`, without the scheme or a trailing slash. */
export function describeTerminalAddress(url: string): string {
    return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
}

function resolveStatus(member: SessionTerminalMemberV1, summary: TerminalSurfaceSummary | null, context: SessionTerminalDescribeContext): SessionTerminalStatus | null {
    if (member.target.kind === 'session_attach' && context.agentAsking) return 'attention';
    // An unreachable machine keeps its terminals running; every other error uses the shared projection.
    if (summary?.failure === 'connection-lost') return 'connection-lost';
    if (summary?.failure === 'failed') return 'failed';
    if (summary?.status === 'exited') return 'exited';
    if (summary?.bell) return 'attention';
    if (summary?.url) return 'running';
    const target = member.target;
    const runsCommand = (target.kind === 'workspace_shell' || target.kind === 'machine_shell') && Boolean(target.launch);
    return runsCommand && summary?.status === 'connected' ? 'running' : null;
}

function resolveDefaultTitle(member: SessionTerminalMemberV1, context: SessionTerminalDescribeContext): string {
    const target = member.target;
    switch (target.kind) {
        case 'session_attach': return context.agentName ?? t('terminalWorkspace.shell');
        case 'machine_shell': return target.machineId !== context.sessionMachineId
            ? context.machineName(target.machineId) ?? basename(target.cwd)
            : t('terminalWorkspace.shell');
        case 'terminal_view': return basename(target.cwd);
        case 'workspace_shell': return t('terminalWorkspace.shell');
    }
}

function resolvePlace(member: SessionTerminalMemberV1, context: SessionTerminalDescribeContext): string | null {
    const target = member.target;
    if (target.kind === 'session_attach') {
        const agent = context.agentName ?? t('terminalWorkspace.shell');
        if (context.agentTerminalHost && context.sessionMachineName) {
            return t('terminalWorkspace.agentTerminalOn', { agent, host: context.agentTerminalHost, machine: context.sessionMachineName });
        }
        return t('terminalWorkspace.agentTerminal', { agent });
    }
    if (target.kind === 'machine_shell' && target.machineId !== context.sessionMachineId) {
        return t('terminalWorkspace.placeOnMachine', { cwd: target.cwd, machine: context.machineName(target.machineId) ?? target.machineId });
    }
    if (target.kind === 'terminal_view') return isTerminalTargetReadOnly(target)
        ? t('terminalWorkspace.readOnlyPlace', { cwd: target.cwd }) : target.cwd;
    return null;
}

/** What a terminal is called before its workspace tells it apart from its siblings: its own name, its shell's title, else its kind. */
function resolveTitle(member: SessionTerminalMemberV1, summary: TerminalSurfaceSummary | null, context: SessionTerminalDescribeContext): string {
    return member.title ?? summary?.title ?? resolveDefaultTitle(member, context);
}

export function describeSessionTerminal(
    member: SessionTerminalMemberV1,
    summary: TerminalSurfaceSummary | null,
    context: SessionTerminalDescribeContext,
    /** The workspace's distinguishing name for this terminal (see `describeSessionTerminalTabs`). */
    distinctTitle?: string,
): SessionTerminalDescriptor {
    const status = resolveStatus(member, summary, context);
    const title = distinctTitle ?? resolveTitle(member, summary, context);
    const place = resolvePlace(member, context);
    const url = summary?.url ?? null;
    const mark: SessionTerminalMark = member.target.kind === 'session_attach' && context.agentId
        ? { kind: 'agent', agentId: context.agentId }
        : member.target.kind === 'machine_shell' && member.target.machineId !== context.sessionMachineId
            ? { kind: 'machine' }
            : { kind: 'shell' };
    // The second line says what the terminal is doing when that is known, else where it runs.
    const detail = status === 'attention' && member.target.kind === 'session_attach' ? t('terminalWorkspace.status.needsYou')
        : status === 'exited' ? t('terminalWorkspace.status.exited')
        : status === 'connection-lost' ? t('terminalWorkspace.states.connectionLost', { title })
        : status === 'failed' ? t('terminalWorkspace.status.failed')
        : url ? describeTerminalAddress(url)
        : member.title && summary?.title && summary.title !== member.title ? summary.title
        : place;
    return { terminalId: member.id, title, mark, status, detail, place, url, borrowed: member.target.kind === 'terminal_view' };
}

/** A tab is one terminal, or a split group read as "zsh │ vite"; it asks for the loudest member status. */
export function describeSessionTerminalTab(tab: SessionTerminalTabV1, members: readonly SessionTerminalDescriptor[]): SessionTerminalTabDescriptor {
    const focused = members.find((member) => member.terminalId === tab.focusedTerminalId) ?? members[0];
    const status = members.reduce<SessionTerminalStatus | null>((loudest, member) => (
        member.status && (!loudest || STATUS_RANK[member.status] > STATUS_RANK[loudest]) ? member.status : loudest
    ), null);
    return {
        tabId: tab.id,
        title: members.map((member) => member.title).join(' │ '),
        mark: focused?.mark ?? { kind: 'shell' },
        status,
        members,
    };
}

/**
 * Every tab of a terminal workspace, described in strip order. `summaries` line up with the workspace's
 * terminals read tab by tab. Terminals that would read the same are numbered after the first ("Shell",
 * "Shell 2"), as JetBrains and VS Code number duplicate terminal names, so tabs can be told apart from
 * what the workspace already knows. The number follows strip order; closing an earlier one renumbers.
 */
export function describeSessionTerminalTabs(
    tabs: readonly SessionTerminalTabV1[],
    summaries: readonly (TerminalSurfaceSummary | null)[],
    context: SessionTerminalDescribeContext,
): SessionTerminalTabDescriptor[] {
    const members = tabs.flatMap(tab => tab.terminals);
    const titles = members.map((member, index) => resolveTitle(member, summaries[index] ?? null, context));
    const totals = new Map<string, number>();
    for (const title of titles) totals.set(title, (totals.get(title) ?? 0) + 1);
    const seen = new Map<string, number>();
    const distinct = titles.map(title => {
        const ordinal = (seen.get(title) ?? 0) + 1;
        seen.set(title, ordinal);
        return ordinal > 1 && (totals.get(title) ?? 0) > 1 ? t('terminalWorkspace.numberedTitle', { title, number: ordinal }) : title;
    });
    let index = 0;
    return tabs.map(tab => describeSessionTerminalTab(tab, tab.terminals.map(member => {
        const at = index++;
        return describeSessionTerminal(member, summaries[at] ?? null, context, distinct[at]);
    })));
}

export function describeSessionTerminalStatus(status: SessionTerminalStatus, title = t('terminalWorkspace.shell')): string {
    switch (status) {
        case 'running': return t('terminalWorkspace.status.running');
        case 'attention': return t('terminalWorkspace.status.needsYou');
        case 'connection-lost': return t('terminalWorkspace.states.connectionLost', { title });
        case 'exited': return t('terminalWorkspace.status.exited');
        case 'failed': return t('terminalWorkspace.status.failed');
    }
}
