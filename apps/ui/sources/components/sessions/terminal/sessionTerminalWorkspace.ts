import { SessionTerminalWorkspaceV1Schema, type SessionTerminalLayoutV1, type SessionTerminalMemberV1, type SessionTerminalTabV1, type SessionTerminalWorkspaceV1 } from '@happier-dev/protocol/terminal';
import { splitCanvasReduce } from '@/components/appShell/splitCanvas/model/splitCanvasReducer';
import type { SplitCanvasLeafNode, SplitCanvasNode, SplitCanvasState } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { collectSplitCanvasLeaves } from '@/components/appShell/splitCanvas/model/splitCanvasTree';

export type SessionTerminalWorkspaceCommand =
    | { type: 'open'; terminal: SessionTerminalMemberV1 }
    | { type: 'split'; tabId?: string; terminal: SessionTerminalMemberV1; availableWidthPx: number; minimumTerminalWidthPx: number }
    | { type: 'focus'; terminalId: string }
    | { type: 'close'; terminalId: string }
    | { type: 'closeTab'; tabId: string }
    | { type: 'closeOthers'; tabId: string }
    | { type: 'detach'; terminalId: string; newTabId: string }
    | { type: 'reorder'; tabId: string; index: number }
    | { type: 'rename'; terminalId: string; title: string | null }
    | { type: 'showList'; showList: boolean }
    | { type: 'resize'; tabId: string; splitId: string; ratio: number; availableWidthPx: number; minimumTerminalWidthPx: number; minimumFirstWidthPx?: number; minimumSecondWidthPx?: number };

const initialWorkspace: SessionTerminalWorkspaceV1 = {
    v: 1, tabs: [{ id: 'embedded', terminals: [{ id: 'embedded', target: { kind: 'workspace_shell' } }], focusedTerminalId: 'embedded', root: { kind: 'leaf', terminalId: 'embedded' } }], activeTabId: 'embedded', showList: false,
};

export function readSessionTerminalWorkspace(value: unknown): SessionTerminalWorkspaceV1 {
    // Missing predecessor state gets its original shell. An explicitly empty workspace stays empty.
    const parsed = SessionTerminalWorkspaceV1Schema.safeParse(value);
    return parsed.success ? value as SessionTerminalWorkspaceV1 : initialWorkspace;
}

function leaf(terminal: SessionTerminalMemberV1): SplitCanvasLeafNode<SessionTerminalMemberV1> {
    return { id: terminal.id, kind: 'leaf', leafKind: 'terminal', payload: terminal };
}

export function sessionTerminalTabToSplitCanvas(tab: SessionTerminalTabV1): SplitCanvasState<SessionTerminalMemberV1> {
    const toCanvas = (node: SessionTerminalLayoutV1): SplitCanvasNode<SessionTerminalMemberV1> => node.kind === 'leaf'
        ? leaf(tab.terminals.find((terminal) => terminal.id === node.terminalId)!)
        : { id: node.id, kind: 'split', axis: 'row', ratio: node.ratio, first: toCanvas(node.first), second: toCanvas(node.second) };
    return {
        root: toCanvas(tab.root),
        focusedLeafId: tab.focusedTerminalId, maximizedLeafId: null,
    };
}

function fromCanvas(node: SplitCanvasNode<SessionTerminalMemberV1>): SessionTerminalLayoutV1 {
    return node.kind === 'leaf' ? { kind: 'leaf', terminalId: node.id }
        : { kind: 'split', id: node.id, ratio: node.ratio, first: fromCanvas(node.first), second: fromCanvas(node.second) };
}

export function getActiveSessionTerminal(workspace: SessionTerminalWorkspaceV1): SessionTerminalMemberV1 | null {
    const tab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId);
    return tab?.terminals.find((terminal) => terminal.id === tab.focusedTerminalId) ?? null;
}

export function reduceSessionTerminalWorkspace(state: SessionTerminalWorkspaceV1, command: SessionTerminalWorkspaceCommand): SessionTerminalWorkspaceV1 {
    const contains = (id: string) => state.tabs.some((tab) => tab.terminals.some((terminal) => terminal.id === id));
    const replace = (tab: SessionTerminalTabV1) => ({ ...state, tabs: state.tabs.map((current) => current.id === tab.id ? tab : current) });
    switch (command.type) {
        case 'open': {
            if (contains(command.terminal.id) || state.tabs.some((tab) => tab.id === command.terminal.id)) return state;
            return { ...state, tabs: [...state.tabs, { id: command.terminal.id, terminals: [command.terminal], focusedTerminalId: command.terminal.id, root: { kind: 'leaf', terminalId: command.terminal.id } }], activeTabId: command.terminal.id };
        }
        case 'focus': {
            const tab = state.tabs.find((tab) => tab.terminals.some((terminal) => terminal.id === command.terminalId));
            if (!tab || (state.activeTabId === tab.id && tab.focusedTerminalId === command.terminalId)) return state;
            return { ...replace({ ...tab, focusedTerminalId: command.terminalId }), activeTabId: tab.id };
        }
        case 'split': {
            const tab = state.tabs.find((tab) => tab.id === (command.tabId ?? state.activeTabId));
            if (!tab || contains(command.terminal.id)) return state;
            const canvas = sessionTerminalTabToSplitCanvas(tab);
            const next = splitCanvasReduce(canvas, { type: 'splitLeaf', targetLeafId: tab.focusedTerminalId, axis: 'row', placement: 'after', newLeaf: leaf(command.terminal), availableSizePx: command.availableWidthPx, minimumFirstSizePx: command.minimumTerminalWidthPx, minimumSecondSizePx: command.minimumTerminalWidthPx });
            if (next === canvas || !next.root) return state;
            return { ...replace({ ...tab, terminals: collectSplitCanvasLeaves(next.root).map((leaf) => leaf.payload), focusedTerminalId: command.terminal.id, root: fromCanvas(next.root) }), activeTabId: tab.id };
        }
        case 'close': {
            const tab = state.tabs.find((tab) => tab.terminals.some((terminal) => terminal.id === command.terminalId));
            if (!tab) return state;
            if (tab.terminals.length === 1) return reduceSessionTerminalWorkspace(state, { type: 'closeTab', tabId: tab.id });
            const next = splitCanvasReduce(sessionTerminalTabToSplitCanvas(tab), { type: 'closeLeaf', leafId: command.terminalId });
            return replace({ ...tab, terminals: tab.terminals.filter((terminal) => terminal.id !== command.terminalId), focusedTerminalId: next.focusedLeafId!, root: fromCanvas(next.root!) });
        }
        case 'closeTab': {
            const index = state.tabs.findIndex((tab) => tab.id === command.tabId);
            if (index < 0) return state;
            const tabs = state.tabs.filter((tab) => tab.id !== command.tabId);
            return { ...state, tabs, activeTabId: state.activeTabId === command.tabId ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null : state.activeTabId };
        }
        case 'closeOthers': {
            const tab = state.tabs.find((tab) => tab.id === command.tabId);
            return !tab || (state.tabs.length === 1 && state.activeTabId === tab.id) ? state : { ...state, tabs: [tab], activeTabId: tab.id };
        }
        case 'detach': {
            const tab = state.tabs.find((tab) => tab.terminals.some((terminal) => terminal.id === command.terminalId));
            const terminal = tab?.terminals.find((terminal) => terminal.id === command.terminalId);
            if (!tab || !terminal || tab.terminals.length === 1 || !command.newTabId.trim() || state.tabs.some((tab) => tab.id === command.newTabId)) return state;
            const removed = reduceSessionTerminalWorkspace(state, { type: 'close', terminalId: terminal.id });
            return { ...removed, tabs: [...removed.tabs, { id: command.newTabId, terminals: [terminal], focusedTerminalId: terminal.id, root: { kind: 'leaf', terminalId: terminal.id } }], activeTabId: command.newTabId };
        }
        case 'reorder': {
            const source = state.tabs.findIndex((tab) => tab.id === command.tabId);
            if (source < 0 || !Number.isInteger(command.index)) return state;
            const index = Math.max(0, Math.min(state.tabs.length - 1, command.index));
            if (index === source) return state;
            const tabs = [...state.tabs];
            const [tab] = tabs.splice(source, 1);
            tabs.splice(index, 0, tab);
            return { ...state, tabs };
        }
        case 'rename': {
            const tab = state.tabs.find((tab) => tab.terminals.some((terminal) => terminal.id === command.terminalId));
            if (!tab) return state;
            const title = command.title?.trim() || undefined;
            if (tab.terminals.find((terminal) => terminal.id === command.terminalId)?.title === title) return state;
            return replace({ ...tab, terminals: tab.terminals.map((terminal) => {
                if (terminal.id !== command.terminalId) return terminal;
                const { title: previousTitle, ...rest } = terminal;
                return title ? { ...rest, title } : rest;
            }) });
        }
        case 'showList': return state.showList === command.showList ? state : { ...state, showList: command.showList };
        case 'resize': {
            const tab = state.tabs.find((tab) => tab.id === command.tabId);
            if (!tab || !Number.isFinite(command.ratio)) return state;
            const canvas = sessionTerminalTabToSplitCanvas(tab);
            const next = splitCanvasReduce(canvas, { type: 'setSplitRatio', splitId: command.splitId, ratio: command.ratio, availableSizePx: command.availableWidthPx, minimumFirstSizePx: command.minimumFirstWidthPx ?? command.minimumTerminalWidthPx, minimumSecondSizePx: command.minimumSecondWidthPx ?? command.minimumTerminalWidthPx });
            if (!next.root || next.root === canvas.root) return state;
            return replace({ ...tab, root: fromCanvas(next.root) });
        }
    }
}
