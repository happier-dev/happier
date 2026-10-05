import * as React from 'react';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import type { DocumentTabStatus } from '@/components/ui/navigation/DocumentTabStrip';

import type { SessionTerminalMark, SessionTerminalStatus, SessionTerminalTabDescriptor } from '../presentation/describeSessionTerminal';

/**
 * The three menus of the session terminal pane (terminal lab M). Builders are pure over plain inputs,
 * so the desktop strip and the phone Terminal page offer the same verbs under the same ids.
 */

export const TERMINAL_MENU_GLYPH_PX = 16;

/** A terminal status as the shared tab status tone (strip tabs, list rows, phone chips). */
export const SESSION_TERMINAL_STATUS_TONE: Readonly<Record<SessionTerminalStatus, DocumentTabStatus['tone']>> = {
    running: 'running', attention: 'attention', exited: 'ended', failed: 'failed',
};

type Glyph = (name: IconName) => React.ReactNode;

export function renderSessionTerminalMark(mark: SessionTerminalMark, sizePx: number, color: string): React.ReactNode {
    if (mark.kind === 'agent') return <AgentIcon agentId={mark.agentId} size={sizePx} />;
    return <Icon name={mark.kind === 'machine' ? 'hard-drives' : 'terminal'} size={sizePx} color={color} />;
}

/* ── + ▾ · New terminal ───────────────────────────────────────────────────── */

export type SessionTerminalNewMenuInput = Readonly<{
    folder: string | null;
    machineName: string | null;
    shellShortcut?: string;
    agent: Readonly<{ agentId: string; name: string; available: boolean; unavailableReason: string | null }> | null;
    scripts: readonly Readonly<{ id: string; title: string; command: string | null }>[];
    machines: readonly Readonly<{ id: string; name: string; online: boolean; cwd: string | null; lastSeen: string | null }>[];
}>;

export function buildSessionTerminalNewMenuItems(input: SessionTerminalNewMenuInput, glyph: Glyph, agentMark: (agentId: string) => React.ReactNode): DropdownMenuItem[] {
    const items: DropdownMenuItem[] = [{
        id: 'shell',
        testID: 'terminal-new-menu-shell',
        category: t('terminalWorkspace.jump.thisSession'),
        title: input.folder ? t('terminalWorkspace.newMenu.shellIn', { folder: input.folder }) : t('terminalWorkspace.shell'),
        ...(input.machineName && input.folder ? { subtitle: t('terminalWorkspace.placeOnMachine', { cwd: input.folder, machine: input.machineName }) } : {}),
        icon: glyph('terminal'),
        ...(input.shellShortcut ? { shortcut: input.shellShortcut } : {}),
    }];
    if (input.agent) {
        items.push({
            id: 'agent',
            testID: 'terminal-new-menu-agent',
            category: t('terminalWorkspace.jump.thisSession'),
            title: t('terminalWorkspace.agentTerminal', { agent: input.agent.name }),
            subtitle: input.agent.available ? t('terminalWorkspace.agentTerminalHint', { agent: input.agent.name }) : input.agent.unavailableReason ?? undefined,
            icon: agentMark(input.agent.agentId),
            disabled: !input.agent.available,
        });
    }
    for (const script of input.scripts) {
        items.push({
            id: `script:${script.id}`,
            testID: `terminal-new-menu-script-${script.id}`,
            category: t('terminalWorkspace.newMenu.runScript'),
            title: script.title,
            subtitle: t('terminalWorkspace.newMenu.scriptInNewTab', { command: script.command ?? script.title }),
            icon: glyph('play'),
        });
    }
    items.push({ id: 'allScripts', testID: 'terminal-new-menu-all-scripts', category: t('terminalWorkspace.newMenu.runScript'), title: t('terminalWorkspace.newMenu.allScripts'), icon: glyph('list') });
    for (const machine of input.machines) {
        items.push({
            id: `machine:${machine.id}`,
            testID: `terminal-new-menu-machine-${machine.id}`,
            category: t('terminalWorkspace.newMenu.otherMachine'),
            title: machine.name,
            subtitle: machine.online
                ? t('terminalWorkspace.newMenu.machineOnline', { cwd: machine.cwd ?? '~' })
                : machine.lastSeen ?? t('terminalWorkspace.newMenu.machineOffline'),
            icon: glyph('hard-drives'),
            disabled: !machine.online || !machine.cwd,
        });
    }
    return items;
}

/* ── Tab ⋯ / right-click · one terminal ───────────────────────────────────── */

export type SessionTerminalTabMenuInput = Readonly<{
    tab: SessionTerminalTabDescriptor;
    /** The terminal the verbs act on: the tab's focused member. */
    terminalId: string;
    mounted: Readonly<{ copySelection: boolean; paste: boolean; clear: boolean; restart: boolean; find?: boolean }>;
    canSplit: boolean;
    canOpenInDetails: boolean;
    splitShortcut?: string;
    hasOtherTabs: boolean;
}>;

export function buildSessionTerminalTabMenuItems(input: SessionTerminalTabMenuInput, glyph: Glyph): DropdownMenuItem[] {
    const member = input.tab.members.find((candidate) => candidate.terminalId === input.terminalId) ?? input.tab.members[0];
    const borrowed = member?.borrowed === true;
    const items: DropdownMenuItem[] = [
        { id: 'rename', testID: 'terminal-tab-menu-rename', title: t('terminalWorkspace.tabMenu.rename'), icon: glyph('pencil-simple') },
        { id: 'splitRight', testID: 'terminal-tab-menu-split', title: t('terminalWorkspace.tabMenu.splitRight'), icon: glyph('square-split-horizontal'), disabled: !input.canSplit, ...(input.splitShortcut ? { shortcut: input.splitShortcut } : {}) },
    ];
    if (input.mounted.find) {
        items.push({ id: 'find', testID: 'terminal-tab-menu-find', title: t('find.open'), icon: glyph('magnifying-glass') });
    }
    if (input.tab.members.length > 1) {
        items.push({ id: 'moveToOwnTab', testID: 'terminal-tab-menu-detach', title: t('terminalWorkspace.tabMenu.moveToOwnTab'), icon: glyph('arrow-square-out') });
    }
    if (input.canOpenInDetails) {
        items.push({ id: 'openInDetails', testID: 'terminal-tab-menu-details', title: t('terminalWorkspace.tabMenu.openInDetails'), subtitle: t('terminalWorkspace.tabMenu.openInDetailsHint'), icon: glyph('sidebar-right-open') });
    }
    items.push(
        { id: 'copySelection', testID: 'terminal-tab-menu-copy', title: t('terminalWorkspace.tabMenu.copySelection'), icon: glyph('copy'), disabled: !input.mounted.copySelection },
    );
    if (!borrowed) {
        items.push(
            { id: 'paste', testID: 'terminal-tab-menu-paste', title: t('terminalWorkspace.tabMenu.paste'), icon: glyph('clipboard'), disabled: !input.mounted.paste },
            { id: 'clear', testID: 'terminal-tab-menu-clear', title: t('terminalWorkspace.tabMenu.clear'), icon: glyph('trash'), disabled: !input.mounted.clear },
            { id: 'restart', testID: 'terminal-tab-menu-restart', title: t('terminalWorkspace.tabMenu.restart'), subtitle: t('terminalWorkspace.tabMenu.restartHint', { title: member?.title ?? input.tab.title }), icon: glyph('arrow-clockwise'), disabled: !input.mounted.restart },
        );
    }
    items.push(borrowed
        ? { id: 'close', testID: 'terminal-tab-menu-close', title: t('terminalWorkspace.tabMenu.closeView'), subtitle: t('terminalWorkspace.tabMenu.closeViewHint'), icon: glyph('x') }
        : { id: 'close', testID: 'terminal-tab-menu-close', title: t('terminalWorkspace.tabMenu.close'), subtitle: t('terminalWorkspace.tabMenu.closeHint'), icon: glyph('x') });
    if (input.hasOtherTabs) {
        items.push({ id: 'closeOthers', testID: 'terminal-tab-menu-close-others', title: t('terminalWorkspace.tabMenu.closeOthers'), icon: glyph('x') });
    }
    return items;
}

/* ── Strip ⋯ · the bottom pane ────────────────────────────────────────────── */

export type SessionTerminalPaneMenuInput = Readonly<{
    showList: boolean;
    canJump: boolean;
    jumpShortcut?: string;
    hideShortcut?: string;
    canOpenSettings: boolean;
}>;

export function buildSessionTerminalPaneMenuItems(input: SessionTerminalPaneMenuInput, glyph: Glyph): DropdownMenuItem[] {
    const items: DropdownMenuItem[] = [];
    if (input.canJump) {
        items.push({ id: 'jump', testID: 'terminal-pane-menu-jump', title: t('terminalWorkspace.paneMenu.jump'), icon: glyph('arrow-right'), ...(input.jumpShortcut ? { shortcut: input.jumpShortcut } : {}) });
    }
    items.push(
        { id: 'showList', testID: 'terminal-pane-menu-show-list', title: t('terminalWorkspace.paneMenu.showList'), subtitle: t('terminalWorkspace.paneMenu.showListHint'), icon: glyph('list'), checked: input.showList },
        { id: 'hide', testID: 'terminal-pane-menu-hide', title: t('terminalWorkspace.paneMenu.hide'), subtitle: t('terminalWorkspace.paneMenu.hideHint'), icon: glyph('caret-down'), ...(input.hideShortcut ? { shortcut: input.hideShortcut } : {}) },
    );
    if (input.canOpenSettings) {
        items.push({ id: 'settings', testID: 'terminal-pane-menu-settings', title: t('terminalWorkspace.paneMenu.settings'), subtitle: t('terminalWorkspace.paneMenu.settingsHint'), icon: glyph('gear') });
    }
    return items;
}
