import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, createSessionFixture, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { useSessionTerminalDescribeContext } from './useSessionTerminalPresentation';
import { t } from '@/text';

import type { SessionTerminalTabV1 } from '@happier-dev/protocol/terminal/workspace';

import { projectTerminalSurfaceFailure, type TerminalSurfaceSummary } from '../terminalSurfaceSummary';
import { describeSessionTerminal, describeSessionTerminalTab, describeSessionTerminalTabs, type SessionTerminalDescribeContext } from './describeSessionTerminal';

afterEach(standardCleanup);

const context = (overrides: Partial<SessionTerminalDescribeContext> = {}): SessionTerminalDescribeContext => ({
    agentId: 'claude',
    agentName: 'Claude',
    agentAsking: false,
    agentTerminalHost: 'tmux',
    sessionMachineId: 'mbp',
    sessionMachineName: 'MacBook Pro',
    machineName: (id) => (id === 'devbox' ? 'devbox' : null),
    ...overrides,
});
const summary = (overrides: Partial<TerminalSurfaceSummary> & { connectionLost?: boolean; readOnly?: boolean }): TerminalSurfaceSummary => {
    const value = { title: null, bell: null, status: 'connected' as const, error: null, url: null, ...overrides };
    return { ...value, failure: projectTerminalSurfaceFailure({
        status: value.status,
        error: value.error,
        connectionLost: overrides.connectionLost,
        readOnly: overrides.readOnly ?? false,
    }) };
};

describe('describeSessionTerminal (terminal lab B1/A1/ST)', () => {
    it('describes interactive service input truthfully while retaining view-only close semantics', () => {
        const target = { kind: 'terminal_view' as const, machineId: 'mbp', terminalId: 'service', terminalKey: 'service', cwd: '/repo' };
        expect(describeSessionTerminal({ id: 'service', target: { ...target, interactive: true } }, null, context()))
            .toMatchObject({ place: '/repo', borrowed: true });
        expect(describeSessionTerminal({ id: 'logs', target }, null, context()))
            .toMatchObject({ place: t('terminalWorkspace.readOnlyPlace', { cwd: '/repo' }), borrowed: true });
    });

    it.each(['codex', 'acme.agent', null])('uses public Session Agent %s for the attached terminal mark', async agentId => {
        const initial = getStorage().getState();
        const session = createSessionFixture({ id: 'terminal-agent', serverId: 'home', metadataLayoutVersion: 1,
            metadata: { v: 1, ...(agentId ? { agentPresentation: { agentId } } : {}) } as never,
            ownerMetadataView: { path: '/private', host: 'home', flavor: 'claude' } });
        getStorage().setState({ sessions: { [session.id]: session } });
        try {
            const hook = await renderHook(() => useSessionTerminalDescribeContext(session.id, 'home'));
            const description = describeSessionTerminal({ id: 'agent-terminal', target: { kind: 'session_attach' } }, null, hook.getCurrent());
            expect(description.mark).toEqual(agentId ? { kind: 'agent', agentId } : { kind: 'shell' });
            await hook.unmount();
        } finally { getStorage().setState(initial, true); }
    });

    it('turns the agent’s tab amber while it asks in its own terminal, and names where it runs', () => {
        const asking = describeSessionTerminal({ id: 'a', target: { kind: 'session_attach' } }, summary({}), context({ agentAsking: true }));
        expect(asking).toMatchObject({ title: 'Claude', status: 'attention', mark: { kind: 'agent', agentId: 'claude' } });
        expect(asking.place).toContain('tmux');
        expect(describeSessionTerminal({ id: 'a', target: { kind: 'session_attach' } }, summary({}), context()).status).toBeNull();
    });

    it('keeps a shell on an unreachable machine out of the failed state; a start failure fails', () => {
        const shell = { id: 's', target: { kind: 'workspace_shell' as const } };
        expect(describeSessionTerminal(shell, summary({ status: 'error', error: 'terminal_machine_unreachable' }), context()).status).toBeNull();
        expect(describeSessionTerminal(shell, summary({ status: 'error', error: 'terminal_cwd_denied' }), context()).status).toBe('failed');
        expect(describeSessionTerminal(shell, summary({ status: 'exited' }), context()).status).toBe('exited');
    });

    it('reports a post-connect loss without reclassifying a real start failure', () => {
        const shell = { id: 's', target: { kind: 'workspace_shell' as const }, title: 'Shell' };
        expect(describeSessionTerminal(shell, summary({
            status: 'error', error: 'terminal_stream_dropped', connectionLost: true,
        }), context())).toMatchObject({
            status: 'connection-lost',
            detail: 'Lost connection to Shell · it keeps running',
        });
        expect(describeSessionTerminal(shell, summary({
            status: 'error', error: 'terminal_cwd_denied', connectionLost: false,
        }), context())).toMatchObject({ status: 'failed', detail: 'Couldn’t start' });
    });

    it('marks a terminal serving an address as running and says the address, without a scheme', () => {
        const vite = describeSessionTerminal({ id: 'v', target: { kind: 'workspace_shell' }, title: 'vite' }, summary({ url: 'http://localhost:5173/' }), context());
        expect(vite).toMatchObject({ title: 'vite', status: 'running', detail: 'localhost:5173', url: 'http://localhost:5173/' });
    });

    it('names a shell on another machine by the machine and says where it runs', () => {
        const devbox = describeSessionTerminal({ id: 'd', target: { kind: 'machine_shell', machineId: 'devbox', cwd: '~/' } }, null, context());
        expect(devbox).toMatchObject({ title: 'devbox', mark: { kind: 'machine' } });
        expect(devbox.place).toContain('devbox');
    });

    it('reads a split tab as both names and asks with its loudest member', () => {
        const tab: SessionTerminalTabV1 = {
            id: 't', focusedTerminalId: 'z',
            terminals: [{ id: 'z', target: { kind: 'workspace_shell' }, title: 'zsh' }, { id: 'v', target: { kind: 'workspace_shell' }, title: 'vite' }],
            root: { kind: 'split', id: 'sp', ratio: 0.5, first: { kind: 'leaf', terminalId: 'z' }, second: { kind: 'leaf', terminalId: 'v' } },
        };
        const members = [
            describeSessionTerminal(tab.terminals[0]!, summary({}), context()),
            describeSessionTerminal(tab.terminals[1]!, summary({ url: 'http://localhost:5173/' }), context()),
        ];
        expect(describeSessionTerminalTab(tab, members)).toMatchObject({ title: 'zsh │ vite', status: 'running' });
    });
    it('numbers Shells that would read the same, in strip order, so every tab can be told apart', () => {
        const shell = (id: string, title?: string) => ({ id, target: { kind: 'workspace_shell' as const }, ...(title ? { title } : {}) });
        const tab = (id: string, ...terminals: ReturnType<typeof shell>[]): SessionTerminalTabV1 => ({
            id, focusedTerminalId: terminals[0]!.id, terminals,
            root: terminals.length === 1 ? { kind: 'leaf', terminalId: terminals[0]!.id }
                : { kind: 'split', id: `${id}-split`, ratio: 0.5, first: { kind: 'leaf', terminalId: terminals[0]!.id }, second: { kind: 'leaf', terminalId: terminals[1]!.id } },
        });
        const [lone] = describeSessionTerminalTabs([tab('lone', shell('lone'))], [null], context());
        const plain = lone!.title;
        // A lone Shell keeps its plain name; nothing is numbered until a second would read the same.
        expect(lone!.members[0]!.title).toBe(plain);
        const tabs = describeSessionTerminalTabs([
            tab('a', shell('a')),
            tab('b', shell('b'), shell('c')),
            tab('d', shell('d')),
            tab('e', shell('e', 'api')),
        ], [null, null, summary({ title: 'vim' }), null, null], context());
        expect(tabs.map(item => item.members.map(member => member.title))).toEqual([
            [plain], [`${plain} 2`, 'vim'], [`${plain} 3`], ['api'],
        ]);
        expect(tabs[1]!.title).toBe(`${plain} 2 │ vim`);
        // The numbered name is the one every line about that Shell uses.
        const lost = describeSessionTerminalTabs([tab('a', shell('a')), tab('b', shell('b'))],
            [null, summary({ status: 'error', error: 'gone', connectionLost: true })], context());
        expect(lost[1]!.members[0]!.detail).toContain(`${plain} 2`);
    });
});
