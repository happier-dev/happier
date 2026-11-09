import * as React from 'react';
import type { DaemonTerminalListEntryV1} from '@happier-dev/protocol/daemon/terminal';
import type { SessionTerminalActionId} from '@happier-dev/protocol/actions/sessionTerminalActionFamily';
import type { SessionTerminalTabV1 } from '@happier-dev/protocol/terminal/workspace';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Icon } from '@/components/ui/icons/Icon';
import type { SelectionListSectionDescriptor, SelectionListStep } from '@/components/ui/selectionList';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { machineTerminalList } from '@/sync/ops/machineTerminal';
import { t } from '@/text';
import { formatKeybindingLabel } from '@/keyboard/bindings';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';

import {
    describeSessionTerminalStatus,
    describeTerminalAddress,
    type SessionTerminalMark,
    type SessionTerminalStatus,
    type SessionTerminalTabDescriptor,
} from '../presentation/describeSessionTerminal';
import type { TerminalSurfaceSummary } from '../terminalSurfaceSummary';
import { TerminalJumpStatus } from './TerminalJumpStatus';

/**
 * What the other sessions on this machine left running, read once per Jump from the daemon's PTY
 * registry. `unsupported` is an older daemon without the method: the group is simply absent (the
 * approved fallback). An error is not an empty result: the group stays and says it could not list.
 */
export type OtherSessionTerminals =
    | Readonly<{ status: 'idle' | 'loading' | 'unsupported' | 'error' }>
    | Readonly<{ status: 'ready'; terminals: readonly DaemonTerminalListEntryV1[] }>;

export async function readOtherSessionTerminals(
    machineId: string,
    serverId: string | null,
    signal?: AbortSignal,
): Promise<OtherSessionTerminals> {
    try {
        const response = await machineTerminalList(machineId, { serverId, ...(signal ? { signal } : {}) });
        if (response === null) return { status: 'unsupported' };
        return response.ok ? { status: 'ready', terminals: response.terminals } : { status: 'error' };
    } catch {
        return { status: 'error' };
    }
}

/** The one Action a Jump row runs; every row goes through the canonical session terminal Actions. */
export type TerminalJumpActivation = Readonly<{ actionId: SessionTerminalActionId; input: Readonly<Record<string, unknown>> }>;

export type TerminalJumpModel = Readonly<{
    step: SelectionListStep;
    activations: ReadonlyMap<string, TerminalJumpActivation>;
}>;

export type TerminalJumpModelInput = Readonly<{
    /** This session's tabs, described, in strip order. */
    tabs: readonly SessionTerminalTabDescriptor[];
    workspaceTabs: readonly SessionTerminalTabV1[];
    activeTabId: string | null;
    sessionId: string;
    /** This session's own terminal keys, so a listed PTY that is already a tab is not offered twice. */
    ownTerminalKeys: ReadonlySet<string>;
    machineId: string | null;
    machineName: string | null;
    folderName: string | null;
    others: OtherSessionTerminals;
    /** Last-known summaries of the listed PTYs, by terminal key. */
    readSummary: (terminalKey: string) => TerminalSurfaceSummary | null;
    readSessionName: (sessionId: string) => string;
    scripts: readonly LocalServiceLaunchTarget[];
}>;

function basename(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, '');
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed;
}

function TerminalMarkIcon(props: Readonly<{ mark: SessionTerminalMark }>) {
    if (props.mark.kind === 'agent') return <AgentIcon agentId={props.mark.agentId} size={16} />;
    return <Icon name={props.mark.kind === 'machine' ? 'hard-drives' : 'terminal'} size={16} />;
}

const STATUS_WORDS: readonly SessionTerminalStatus[] = ['running', 'attention', 'exited', 'failed'];

/** A This-session row's second line: where it runs, or what it serves; never its status again. */
function describeTabSubtitle(tab: SessionTerminalTabDescriptor): string | undefined {
    if (tab.members.length > 1) {
        return t('terminalWorkspace.jump.split', {
            members: tab.members.map((member) => (member.url ? describeTerminalAddress(member.url) : member.title)).join(', '),
        });
    }
    const member = tab.members[0];
    if (!member) return undefined;
    if (member.url) return describeTerminalAddress(member.url);
    if (member.place) return member.place;
    const statusWords = new Set(STATUS_WORDS.map(status => describeSessionTerminalStatus(status)));
    if (member.status && member.detail === describeSessionTerminalStatus(member.status, member.title)) return undefined;
    return member.detail && !statusWords.has(member.detail) ? member.detail : undefined;
}

/** The listed PTYs another session of this machine owns: not this session's, newest-running first. */
export function selectOtherSessionTerminals(input: Pick<TerminalJumpModelInput, 'others' | 'sessionId' | 'ownTerminalKeys'>): readonly DaemonTerminalListEntryV1[] {
    if (input.others.status !== 'ready') return [];
    return input.others.terminals
        .filter((entry) => entry.sessionId !== undefined && entry.sessionId !== input.sessionId && !input.ownTerminalKeys.has(entry.terminalKey))
        .slice()
        .sort((a, b) => Number(a.ended) - Number(b.ended));
}

/**
 * The Terminals scope of the palette (terminal lab B4): This session in strip order with live status,
 * Other sessions on this machine (read-only views), New, and — once something is typed — package
 * scripts that run in a new terminal tab.
 */
export function buildTerminalJumpModel(input: TerminalJumpModelInput, query: string): TerminalJumpModel {
    const activations = new Map<string, TerminalJumpActivation>();
    const sections: SelectionListSectionDescriptor[] = [];

    if (input.tabs.length > 0) {
        sections.push({
            kind: 'static',
            id: 'terminal-jump:this-session',
            title: t('terminalWorkspace.jump.thisSession'),
            options: input.tabs.map((tab) => {
                const id = `this:${tab.tabId}`;
                const focused = input.workspaceTabs.find((candidate) => candidate.id === tab.tabId)?.focusedTerminalId;
                if (focused) activations.set(id, { actionId: 'session.terminals.focus', input: { terminalId: focused } });
                const subtitle = describeTabSubtitle(tab);
                const showing = tab.tabId === input.activeTabId;
                return {
                    id,
                    testID: `terminal-jump:${id}`,
                    label: tab.title,
                    ...(subtitle ? { subtitle } : {}),
                    searchText: tab.members.map((member) => [member.title, member.detail, member.place].filter(Boolean).join(' ')).join(' '),
                    icon: <TerminalMarkIcon mark={tab.mark} />,
                    rightAccessory: tab.status || showing ? <TerminalJumpStatus status={tab.status} showing={showing}
                        {...(tab.status === 'connection-lost' ? { title: tab.title } : {})} /> : undefined,
                };
            }),
        });
    }

    const foreign = selectOtherSessionTerminals(input);
    if ((foreign.length > 0 && input.machineId) || input.others.status === 'error') {
        sections.push({
            kind: 'static',
            id: 'terminal-jump:other-sessions',
            title: t('terminalWorkspace.jump.otherSessions', { machine: input.machineName ?? '' }),
            ...(input.others.status === 'error' ? { resultHint: t('terminalWorkspace.jump.otherSessionsUnavailable') } : {}),
            options: input.machineId ? foreign.map((entry) => {
                const id = `other:${entry.terminalId}`;
                const summary = input.readSummary(entry.terminalKey);
                const title = summary?.title ?? basename(entry.cwd);
                const session = input.readSessionName(entry.sessionId!);
                activations.set(id, {
                    actionId: 'session.terminals.open',
                    input: {
                        target: {
                            kind: 'terminal_view', machineId: input.machineId, terminalId: entry.terminalId,
                            terminalKey: entry.terminalKey, cwd: entry.cwd, sessionId: entry.sessionId,
                        },
                        title,
                    },
                });
                const status: SessionTerminalStatus | null = entry.ended ? 'exited' : summary?.url ? 'running' : null;
                const subtitle = entry.ended
                    ? entry.exit?.exitCode != null
                        ? t('terminalWorkspace.jump.foreignExitedWithCode', { session, code: entry.exit.exitCode })
                        : t('terminalWorkspace.jump.foreignExited', { session })
                    : t('terminalWorkspace.jump.foreignDetail', { session, detail: summary?.url ? describeTerminalAddress(summary.url) : entry.cwd });
                return {
                    id,
                    testID: `terminal-jump:${id}`,
                    label: title,
                    subtitle,
                    searchText: session,
                    icon: <Icon name="terminal" size={16} />,
                    rightAccessory: status ? <TerminalJumpStatus status={status} showing={false} /> : undefined,
                };
            }) : [],
        });
    }

    activations.set('new:shell', { actionId: 'session.terminals.open', input: { target: { kind: 'workspace_shell' } } });
    sections.push({
        kind: 'static',
        id: 'terminal-jump:new',
        title: t('terminalWorkspace.jump.newGroup'),
        options: [{
            id: 'new:shell',
            testID: 'terminal-jump:new:shell',
            label: t('terminalWorkspace.newMenu.shellIn', { folder: input.folderName ?? t('terminalWorkspace.shell') }),
            icon: <Icon name="plus" size={16} />,
        }],
    });

    const scripts = query.trim().length > 0
        ? input.scripts.filter((script) => script.source === 'package_script' && script.sourceClass?.kind === 'package_script')
        : [];
    if (scripts.length > 0) {
        sections.push({
            kind: 'static',
            id: 'terminal-jump:scripts',
            title: t('terminalWorkspace.jump.runScript'),
            options: scripts.map((script) => {
                const source = script.sourceClass!;
                const id = `script:${script.id}`;
                if (source.kind === 'package_script') {
                    activations.set(id, {
                        actionId: 'session.terminals.run_script',
                        input: { machineId: script.machineId, cwd: source.cwd, runTargetId: source.runTargetId, title: script.title },
                    });
                }
                return {
                    id,
                    testID: `terminal-jump:${id}`,
                    label: source.kind === 'package_script' ? source.scriptName : script.title,
                    subtitle: t('terminalWorkspace.jump.scriptCommand', { command: script.commandPreview ?? script.title }),
                    icon: <Icon name="play" size={16} />,
                };
            }),
        });
    }

    return {
        activations,
        step: {
            id: 'universal-search:terminals',
            title: t('terminalWorkspace.jump.title'),
            inputPlaceholder: t('terminalWorkspace.jump.title'),
            emptyStateLabel: t('selectionList.emptyMatch'),
            sections,
            footerHints: [
                { id: 'move', label: '↑↓', description: t('terminalWorkspace.jump.hintMove') },
                { id: 'show', label: '↵', description: t('terminalWorkspace.jump.hintShow') },
                { id: 'details', label: formatKeybindingLabel({ binding: 'Mod+Enter' }, resolveKeyboardPlatform()), description: t('terminalWorkspace.jump.hintOpenInDetails') },
                { id: 'everything', label: '⌫', description: t('terminalWorkspace.jump.hintSearchEverything') },
                { id: 'close', label: 'esc', description: t('terminalWorkspace.jump.hintClose') },
            ],
        },
    };
}
