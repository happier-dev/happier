import { describe, expect, it, vi } from 'vitest';
import type * as React from 'react';
import type { DaemonTerminalListEntryV1, SessionTerminalTabV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { appPaneReduce, createAppPaneState } from '@/components/appShell/panes/model/appPaneReducer';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import type { SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';

import type { SessionTerminalDescriptor, SessionTerminalTabDescriptor } from '../presentation/describeSessionTerminal';
import { invokeSessionTerminalAction } from '../sessionTerminalActions';
import { registerSessionTerminalWorkspaceOwner } from '../sessionTerminalWorkspaceRuntime';
import { openSessionTerminalInDetails } from '../embeddedTerminalDocking';
import { buildTerminalJumpModel, readOtherSessionTerminals, type TerminalJumpModelInput } from './terminalJumpSections';

// Recipient-envelope HTTP is outside this terminal journey and must remain unused.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Terminal Jump unexpectedly reached the recipient-envelope API'); };
    return {
        createSessionDataKeyEnvelopeClient: unused,
        readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused,
        prepareSessionDataKeyEnvelopesDetached: unused,
    };
});

// The daemon terminal registry is reached over machine RPC: the one real boundary here.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));

const SCOPE = 'session:address:home-jump:session-jump';

function member(id: string, overrides: Partial<SessionTerminalDescriptor> = {}): SessionTerminalDescriptor {
    return { terminalId: id, title: id, mark: { kind: 'shell' }, status: null, detail: null, place: null, url: null, borrowed: false, ...overrides };
}
function tab(tabId: string, members: readonly SessionTerminalDescriptor[], status: SessionTerminalTabDescriptor['status'] = null): SessionTerminalTabDescriptor {
    return { tabId, title: members.map((item) => item.title).join(' │ '), mark: members[0]!.mark, status, members };
}
function layout(tabId: string, ids: readonly string[]): SessionTerminalTabV1 {
    return {
        id: tabId,
        terminals: ids.map((id) => ({ id, target: { kind: 'workspace_shell' as const } })),
        focusedTerminalId: ids[0]!,
        root: ids.length === 1 ? { kind: 'leaf', terminalId: ids[0]! }
            : { kind: 'split', id: `${tabId}-split`, ratio: 0.5, first: { kind: 'leaf', terminalId: ids[0]! }, second: { kind: 'leaf', terminalId: ids[1]! } },
    };
}
function listed(terminalId: string, overrides: Partial<DaemonTerminalListEntryV1> = {}): DaemonTerminalListEntryV1 {
    return { terminalId, terminalKey: `key-${terminalId}`, cwd: '/repo/happier', ended: false, exit: null, ...overrides };
}

function baseInput(overrides: Partial<TerminalJumpModelInput> = {}): TerminalJumpModelInput {
    return {
        tabs: [
            tab('claude', [member('claude', { mark: { kind: 'agent', agentId: 'claude' }, status: 'attention', place: 'Claude’s terminal · tmux on MacBook Pro' })], 'attention'),
            tab('zsh', [member('zsh', { detail: 'yarn test settings --watch' })]),
            tab('servers', [member('vite', { status: 'running', url: 'http://localhost:5173/' }), member('storybook', { status: 'running', url: 'http://localhost:6006' })], 'running'),
        ],
        workspaceTabs: [layout('claude', ['claude']), layout('zsh', ['zsh']), layout('servers', ['vite', 'storybook'])],
        activeTabId: 'zsh',
        sessionId: 'session-jump',
        ownTerminalKeys: new Set(['key-own']),
        machineId: 'machine-mbp',
        machineName: 'MacBook Pro',
        folderName: 'happier',
        others: { status: 'idle' },
        readSummary: () => null,
        readSessionName: (id) => ({ 'session-craft': 'Craft pass lab', 'session-review': 'Review #2481' })[id] ?? id,
        scripts: [],
        ...overrides,
    };
}

function section(sections: readonly SelectionListSectionDescriptor[], id: string) {
    const found = sections.find((candidate) => candidate.id === id);
    return found && found.kind === 'static' ? found : null;
}
function accessoryProps(option: { rightAccessory?: unknown }) {
    return (option.rightAccessory as React.ReactElement<{ status: string | null; showing: boolean }> | undefined)?.props ?? null;
}

describe('Jump to a terminal: the palette Terminals scope', () => {
    it('opens the selected existing terminal in pinned Details and hides its bottom view', async () => {
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'openBottom', scopeId: SCOPE, tabId: 'terminal' });
        openSessionTerminalInDetails({
            openDetailsTab: (tab, options) => { state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: SCOPE, tab, openAs: options?.intent === 'pinned' ? 'pinned' : 'preview' }); },
            closeBottom: () => { state = appPaneReduce(state, { type: 'closeBottom', scopeId: SCOPE }); },
        }, 'vite');
        expect(buildDetailsWorkspaceStateView(state.scopes[SCOPE]!.details).tabs.find((item) => item.key === 'terminal:vite')).toMatchObject({ isPinned: true, resource: { terminalInstanceId: 'vite' } });
        expect(state.scopes[SCOPE]?.bottom.isOpen).toBe(false);
    });
    it('lists this session in strip order with what each terminal is doing, then New', () => {
        const model = buildTerminalJumpModel(baseInput(), '');
        expect(model.step.sections.map((item) => item.id)).toEqual(['terminal-jump:this-session', 'terminal-jump:new']);
        const rows = section(model.step.sections, 'terminal-jump:this-session')!.options;
        expect(rows.map((row) => row.id)).toEqual(['this:claude', 'this:zsh', 'this:servers']);
        expect(accessoryProps(rows[0]!)).toEqual({ status: 'attention', showing: false });
        expect(accessoryProps(rows[1]!)).toEqual({ status: null, showing: true });
        // A split reads as its halves and what they serve.
        expect(rows[2]!.subtitle).toContain('localhost:5173, localhost:6006');
        expect(rows[0]!.subtitle).toBe('Claude’s terminal · tmux on MacBook Pro');
        // Showing the split focuses its focused member through the canonical focus Action.
        expect(model.activations.get('this:servers')).toEqual({ actionId: 'session.terminals.focus', input: { terminalId: 'vite' } });
    });

    it('offers other sessions’ terminals on this machine read-only, running first, never this session’s own', () => {
        const model = buildTerminalJumpModel(baseInput({
            others: { status: 'ready', terminals: [
                listed('test', { sessionId: 'session-review', ended: true, exit: { exitCode: 1, signal: null } }),
                listed('mine', { sessionId: 'session-jump' }),
                listed('own-key', { sessionId: 'session-other', terminalKey: 'key-own' }),
                listed('signin'),
                listed('vite', { sessionId: 'session-craft' }),
            ] },
            readSummary: (key) => (key === 'key-vite' ? { title: 'vite', bell: null, status: 'connected', error: null, url: 'http://localhost:5174/' } : null),
        }), '');
        const rows = section(model.step.sections, 'terminal-jump:other-sessions')!.options;
        expect(rows.map((row) => row.id)).toEqual(['other:vite', 'other:test']);
        expect(rows[0]!.subtitle).toBe('Craft pass lab · localhost:5174');
        expect(accessoryProps(rows[1]!)).toEqual({ status: 'exited', showing: false });
        expect(model.activations.get('other:vite')).toEqual({
            actionId: 'session.terminals.open',
            input: {
                target: { kind: 'terminal_view', machineId: 'machine-mbp', terminalId: 'vite', terminalKey: 'key-vite', cwd: '/repo/happier', sessionId: 'session-craft' },
                title: 'vite',
            },
        });
    });

    it('omits the other-sessions group for an older daemon, but says so when listing failed', () => {
        const unsupported = buildTerminalJumpModel(baseInput({ others: { status: 'unsupported' } }), '');
        expect(section(unsupported.step.sections, 'terminal-jump:other-sessions')).toBeNull();
        const failed = buildTerminalJumpModel(baseInput({ others: { status: 'error' } }), '');
        const group = section(failed.step.sections, 'terminal-jump:other-sessions');
        expect(group?.options).toEqual([]);
        expect(group?.resultHint).toBeTruthy();
    });

    it('offers package scripts in a new tab only once something is typed', () => {
        const script = {
            id: 'package:docs:dev', source: 'package_script', machineId: 'machine-mbp', title: 'docs', confidence: 'medium', state: 'available', actions: ['start'],
            commandPreview: 'yarn docs:dev',
            sourceClass: { kind: 'package_script', runTargetId: 'docs-dev', packageName: 'docs', scriptName: 'docs:dev', cwd: '/repo/happier/apps/docs' },
        } as unknown as LocalServiceLaunchTarget;
        expect(section(buildTerminalJumpModel(baseInput({ scripts: [script] }), '').step.sections, 'terminal-jump:scripts')).toBeNull();
        const typed = buildTerminalJumpModel(baseInput({ scripts: [script] }), 'do');
        expect(section(typed.step.sections, 'terminal-jump:scripts')!.options.map((row) => row.label)).toEqual(['docs:dev']);
        expect(typed.activations.get('script:package:docs:dev')).toEqual({
            actionId: 'session.terminals.run_script',
            input: { machineId: 'machine-mbp', cwd: '/repo/happier/apps/docs', runTargetId: 'docs-dev', title: 'docs' },
        });
    });

    it('reads other sessions’ terminals from the daemon registry; an older daemon is not an error', async () => {
        machineRpc.mockResolvedValueOnce({ ok: true, terminals: [listed('vite', { sessionId: 'session-craft' })] });
        expect(await readOtherSessionTerminals('machine-mbp', 'home-jump')).toEqual({ status: 'ready', terminals: [listed('vite', { sessionId: 'session-craft' })] });
        machineRpc.mockRejectedValueOnce({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, message: 'method not available' });
        expect(await readOtherSessionTerminals('machine-mbp', 'home-jump')).toEqual({ status: 'unsupported' });
        machineRpc.mockRejectedValueOnce(new Error('socket closed'));
        expect(await readOtherSessionTerminals('machine-mbp', 'home-jump')).toEqual({ status: 'error' });
    });

    it('showing another session’s terminal opens it as a read-only view in this session’s pane', async () => {
        machineRpc.mockClear();
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId: SCOPE });
        const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        try {
            const model = buildTerminalJumpModel(baseInput({ others: { status: 'ready', terminals: [listed('vite', { sessionId: 'session-craft' })] } }), '');
            const activation = model.activations.get('other:vite')!;
            const result = await invokeSessionTerminalAction({ actionId: activation.actionId, input: { ...activation.input, scopeId: SCOPE } });
            expect(result).toMatchObject({ ok: true });
            const listedWorkspace = await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId: SCOPE } });
            if (!('workspace' in listedWorkspace) || !listedWorkspace.workspace) throw new Error('No workspace');
            const opened = listedWorkspace.workspace.tabs.find((item) => item.id === listedWorkspace.workspace.activeTabId)?.terminals[0];
            expect(opened).toMatchObject({ title: 'happier', target: { kind: 'terminal_view', terminalId: 'vite', terminalKey: 'key-vite', sessionId: 'session-craft' } });
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { retire(); machineRpc.mockReset(); }
    });
});
